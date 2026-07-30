import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Alert } from "@connected-repo/ui-mui/feedback/Alert";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Card } from "@connected-repo/ui-mui/layout/Card";
import { Container } from "@connected-repo/ui-mui/layout/Container";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { orpcFetch } from "@frontend/utils/orpc.client";
import { CircularProgress, MenuItem, TextField } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-project chat (platform P3, slice-1) — the Claude-like surface where work
 * originates, reachable by any signed-in team member (not just super-admin).
 *
 * A conversational thread: you describe an idea; a free model drafts a full
 * spec (an assistant turn you can review); you queue it as a spec:ready issue
 * the factory claims. Persistence + a live monitor pane + Routines land in
 * later slices; this slice proves the end-to-end chat over the team-scoped RPC.
 */

interface Project {
	id: string;
	repo: string;
	baseBranch: string;
	mode: string;
}

interface Draft {
	title: string;
	tier: string;
	body: string;
	groomedBy: string;
}

type Msg = { id: number } & (
	| { role: "user"; text: string }
	| { role: "assistant"; text: string }
	| { role: "draft"; draft: Draft }
	| { role: "queued"; issue: number; url: string }
);

// Monotonic id for thread messages — module-level so it's stable across
// renders (not a hook dependency) and needs no in-expression assignment.
let msgSeq = 0;
const nextMsgId = (): number => {
	msgSeq += 1;
	return msgSeq;
};

export default function YantraChatPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectId, setProjectId] = useState("");
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const threadRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		orpcFetch.yantra
			.listProjects()
			.then((rows) => {
				setProjects(rows);
				setProjectId((cur) => cur || rows[0]?.id || "");
			})
			.catch((e: unknown) =>
				setError(e instanceof Error ? e.message : "Couldn't load projects"),
			);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new turns
	useEffect(() => {
		threadRef.current?.scrollTo({
			top: threadRef.current.scrollHeight,
			behavior: "smooth",
		});
	}, [messages]);

	const send = useCallback(async () => {
		const idea = input.trim();
		if (idea.length < 4) return;
		setInput("");
		setError(null);
		setMessages((m) => [...m, { id: nextMsgId(), role: "user", text: idea }]);
		setBusy(true);
		try {
			const draft = await orpcFetch.yantra.groom({ idea });
			setMessages((m) => [...m, { id: nextMsgId(), role: "draft", draft }]);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't draft a spec");
		} finally {
			setBusy(false);
		}
	}, [input]);

	const queue = useCallback(
		async (draft: Draft) => {
			if (!projectId) {
				setError("Pick a project first.");
				return;
			}
			setBusy(true);
			setError(null);
			try {
				const res = await orpcFetch.yantra.queueSpec({
					projectId,
					title: draft.title,
					body: draft.body,
					tier: draft.tier as "T0" | "T1" | "T2" | "T3",
				});
				setMessages((m) => [
					...m,
					{ id: nextMsgId(), role: "queued", issue: res.issue, url: res.url },
				]);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Couldn't queue the spec");
			} finally {
				setBusy(false);
			}
		},
		[projectId],
	);

	return (
		<Container maxWidth="md" sx={{ py: 3, height: "100%" }}>
			<Stack spacing={2} sx={{ height: "100%" }}>
				<Stack
					direction="row"
					spacing={2}
					alignItems="center"
					justifyContent="space-between"
				>
					<Typography variant="h5" sx={{ fontWeight: 800 }}>
						Project chat
					</Typography>
					<TextField
						select
						size="small"
						label="Project"
						value={projectId}
						onChange={(e) => setProjectId(e.target.value)}
						sx={{ minWidth: 260 }}
					>
						{projects.length === 0 && (
							<MenuItem value="" disabled>
								No projects yet
							</MenuItem>
						)}
						{projects.map((p) => (
							<MenuItem key={p.id} value={p.id}>
								{p.repo} @ {p.baseBranch} · {p.mode}
							</MenuItem>
						))}
					</TextField>
				</Stack>

				<Card
					ref={threadRef}
					sx={{
						flex: 1,
						overflowY: "auto",
						p: 2,
						bgcolor: "background.default",
					}}
				>
					{messages.length === 0 && (
						<Typography variant="body2" sx={{ opacity: 0.6, p: 2 }}>
							Describe what you want built in plain words — e.g. “Add rate
							limiting to the file-upload endpoint.” A free model drafts the
							spec; you review and queue it, and the factory picks it up.
						</Typography>
					)}
					<Stack spacing={1.5}>
						{messages.map((m) => (
							<Bubble key={m.id} msg={m} busy={busy} onQueue={queue} />
						))}
						{busy && (
							<Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
								<CircularProgress size={16} />
								<Typography variant="body2" sx={{ opacity: 0.7 }}>
									Thinking…
								</Typography>
							</Stack>
						)}
					</Stack>
				</Card>

				{error && <Alert severity="error">{error}</Alert>}

				<Stack direction="row" spacing={1}>
					<TextField
						fullWidth
						multiline
						maxRows={4}
						size="small"
						placeholder="Describe the work… (Enter to send, Shift+Enter for newline)"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void send();
							}
						}}
						disabled={busy}
					/>
					<Button
						variant="contained"
						onClick={() => void send()}
						disabled={busy || input.trim().length < 4}
					>
						Send
					</Button>
				</Stack>
			</Stack>
		</Container>
	);
}

function Bubble({
	msg,
	busy,
	onQueue,
}: {
	msg: Msg;
	busy: boolean;
	onQueue: (d: Draft) => void;
}) {
	if (msg.role === "user") {
		return (
			<Box sx={{ alignSelf: "flex-end", maxWidth: "85%" }}>
				<Card sx={{ p: 1.5, bgcolor: "primary.main", color: "primary.contrastText" }}>
					<Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
						{msg.text}
					</Typography>
				</Card>
			</Box>
		);
	}
	if (msg.role === "assistant") {
		return (
			<Box sx={{ maxWidth: "85%" }}>
				<Card sx={{ p: 1.5 }}>
					<Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
						{msg.text}
					</Typography>
				</Card>
			</Box>
		);
	}
	if (msg.role === "queued") {
		return (
			<Alert severity="success">
				Queued as{" "}
				<a href={msg.url} target="_blank" rel="noreferrer">
					#{msg.issue}
				</a>{" "}
				— the factory claims it on the next tick.
			</Alert>
		);
	}
	// draft
	const d = msg.draft;
	return (
		<Box sx={{ maxWidth: "95%" }}>
			<Card sx={{ p: 2 }}>
				<Typography variant="caption" sx={{ opacity: 0.6 }}>
					Draft spec · groomed by {d.groomedBy}
				</Typography>
				<Typography variant="subtitle1" sx={{ fontWeight: 700, mt: 0.5 }}>
					[{d.tier}] {d.title}
				</Typography>
				<Typography
					variant="body2"
					component="pre"
					sx={{
						whiteSpace: "pre-wrap",
						fontFamily: "monospace",
						mt: 1,
						maxHeight: 260,
						overflowY: "auto",
					}}
				>
					{d.body}
				</Typography>
				<Button
					variant="contained"
					size="small"
					sx={{ mt: 1.5 }}
					disabled={busy}
					onClick={() => onQueue(d)}
				>
					Queue as spec:ready
				</Button>
			</Card>
		</Box>
	);
}
