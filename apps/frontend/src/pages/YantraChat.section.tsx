import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Alert } from "@connected-repo/ui-mui/feedback/Alert";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Card } from "@connected-repo/ui-mui/layout/Card";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { MenuItem, TextField } from "@mui/material";
import { useState } from "react";

/**
 * Chat-first spec intake (Phase 4) — where work originates. You describe an
 * idea in plain words; a free model drafts a full spec; you review/edit and
 * approve; it becomes a spec:ready issue the factory claims. Two steps on
 * purpose: nothing becomes real work until you approve the draft.
 *
 * Talks to the same /super-admin OpenAPI surface as the cockpit (plain authed
 * fetch), so no new client wiring.
 */

interface Project {
	id: string;
	repo: string;
	baseBranch: string;
}

interface Draft {
	title: string;
	tier: string;
	body: string;
	groomedBy: string;
}

const TIERS = ["T0", "T1", "T2", "T3"];

export function YantraChatSection({
	base,
	projects,
}: {
	base: string;
	projects: Project[];
}) {
	const [projectId, setProjectId] = useState("");
	const [idea, setIdea] = useState("");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [created, setCreated] = useState<{ issue: number; url: string } | null>(
		null,
	);

	const effectiveProject = projectId || projects[0]?.id || "";

	const call = async <T,>(path: string, body: unknown): Promise<T> => {
		const res = await fetch(`${base}${path}`, {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			let detail = `HTTP ${res.status}`;
			try {
				const err = (await res.json()) as {
					message?: string;
					data?: { fieldErrors?: Record<string, string[]> };
				};
				const first = Object.entries(err.data?.fieldErrors ?? {})[0];
				detail = first
					? `${first[0]}: ${first[1].join("; ")}`
					: (err.message ?? detail);
			} catch {
				// non-JSON body — keep status
			}
			throw new Error(detail);
		}
		return (await res.json()) as T;
	};

	const draftSpec = async () => {
		setBusy(true);
		setMsg(null);
		setCreated(null);
		try {
			const d = await call<Draft>("/yantra/intake/groom", { idea: idea.trim() });
			setDraft(d);
		} catch (err) {
			setMsg(
				`Couldn't draft — ${err instanceof Error ? err.message : "unknown error"}`,
			);
		} finally {
			setBusy(false);
		}
	};

	const approve = async () => {
		if (!draft) return;
		if (!effectiveProject) {
			setMsg("Pick a project first.");
			return;
		}
		setBusy(true);
		setMsg(null);
		try {
			const res = await call<{ issue: number; url: string }>(
				"/yantra/intake/approve",
				{
					projectId: effectiveProject,
					title: draft.title,
					body: draft.body,
					tier: draft.tier,
				},
			);
			setCreated(res);
			setDraft(null);
			setIdea("");
		} catch (err) {
			setMsg(
				`Couldn't queue — ${err instanceof Error ? err.message : "unknown error"}`,
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card sx={{ p: 3, mb: 3 }}>
			<Typography variant="h6" sx={{ mb: 0.5 }}>
				New work — describe it, approve the spec
			</Typography>
			<Typography variant="body2" sx={{ mb: 2, opacity: 0.7 }}>
				Say what you want in plain words. A free model turns it into a proper
				spec; you review and approve; the factory picks it up on the next tick.
				You approve — you don't have to write the spec.
			</Typography>

			<Stack direction="row" spacing={2} sx={{ mb: 2 }}>
				<TextField
					select
					size="small"
					label="Project"
					value={effectiveProject}
					onChange={(e) => setProjectId(e.target.value)}
					sx={{ minWidth: 240 }}
				>
					{projects.map((p) => (
						<MenuItem key={p.id} value={p.id}>
							{p.repo} @ {p.baseBranch}
						</MenuItem>
					))}
				</TextField>
			</Stack>

			<TextField
				fullWidth
				multiline
				minRows={2}
				label="Your idea"
				placeholder="e.g. Add rate limiting to the file-upload endpoint"
				value={idea}
				onChange={(e) => setIdea(e.target.value)}
				sx={{ mb: 2 }}
			/>
			<Button
				variant="contained"
				disabled={busy || idea.trim().length < 4}
				onClick={draftSpec}
			>
				{busy && !draft ? "Drafting…" : "Draft spec"}
			</Button>

			{draft && (
				<Box sx={{ mt: 3 }}>
					<Typography variant="subtitle2" sx={{ mb: 1, opacity: 0.7 }}>
						Draft (edit anything before approving) · groomed by {draft.groomedBy}
					</Typography>
					<Stack direction="row" spacing={2} sx={{ mb: 2 }}>
						<TextField
							label="Title"
							value={draft.title}
							onChange={(e) => setDraft({ ...draft, title: e.target.value })}
							sx={{ flex: 1 }}
							size="small"
						/>
						<TextField
							select
							label="Tier"
							value={draft.tier}
							onChange={(e) => setDraft({ ...draft, tier: e.target.value })}
							size="small"
							sx={{ minWidth: 90 }}
						>
							{TIERS.map((t) => (
								<MenuItem key={t} value={t}>
									{t}
								</MenuItem>
							))}
						</TextField>
					</Stack>
					<TextField
						fullWidth
						multiline
						minRows={8}
						label="Spec body"
						value={draft.body}
						onChange={(e) => setDraft({ ...draft, body: e.target.value })}
						sx={{ mb: 2, fontFamily: "monospace" }}
					/>
					<Stack direction="row" spacing={2}>
						<Button variant="contained" disabled={busy} onClick={approve}>
							{busy ? "Queuing…" : "Approve & queue as spec:ready"}
						</Button>
						<Button variant="text" disabled={busy} onClick={() => setDraft(null)}>
							Discard
						</Button>
					</Stack>
				</Box>
			)}

			{created && (
				<Alert severity="success" sx={{ mt: 2 }}>
					Queued as{" "}
					<a href={created.url} target="_blank" rel="noreferrer">
						#{created.issue}
					</a>{" "}
					— the factory claims it on the next tick.
				</Alert>
			)}
			{msg && (
				<Alert severity="error" sx={{ mt: 2 }}>
					{msg}
				</Alert>
			)}
		</Card>
	);
}
