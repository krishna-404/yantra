import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Alert } from "@connected-repo/ui-mui/feedback/Alert";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Divider } from "@connected-repo/ui-mui/layout/Divider";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { orpcFetch } from "@frontend/utils/orpc.client";
import {
	CircularProgress,
	Dialog,
	DialogContent,
	DialogTitle,
	FormControlLabel,
	Switch,
	TextField,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";

/**
 * Provider keys — the credentials every run depends on. They used to live only
 * in the super-admin cockpit, so once that was stripped a fresh install had no
 * in-app way to supply the Claude token it can't run without.
 *
 * Two scopes (#138). A key set here belongs to this team; anything the team
 * hasn't set is inherited from the installation-wide key the operator
 * configured, and the row says which it is — the list shows what a run would
 * actually pick up, not merely what happens to be stored.
 *
 * Write-only by design: the server returns the last four characters and nothing
 * else, so a key can be confirmed and rotated but never read back out.
 */

const LABELS: Record<string, { name: string; help: string }> = {
	CLAUDE_CODE_OAUTH_TOKEN: {
		name: "Claude Code",
		help: "Runs advise, execute and grade. Nothing ships without this.",
	},
	OPENCODE_API_KEY: {
		name: "OpenCode Zen",
		help: "Hosted free models for the cheap lane (T0/T1 work).",
	},
	GEMINI_API_KEY: { name: "Gemini", help: "Free lane provider." },
	GROQ_API_KEY: { name: "Groq", help: "Free lane provider." },
	NVIDIA_API_KEY: { name: "NVIDIA", help: "Free lane provider." },
};

type ProviderKeyName = Awaited<
	ReturnType<typeof orpcFetch.yantra.listProviderKeys>
>["known"][number];

interface KeyRow {
	key: string;
	valueHint: string;
	updatedAt: number;
	teamOwned: boolean;
}

export function ProviderKeysDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const [state, setState] = useState<{
		keys: KeyRow[];
		known: ProviderKeyName[];
		canEditInstallation: boolean;
	} | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [installationWide, setInstallationWide] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setState(await orpcFetch.yantra.listProviderKeys({}));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load provider keys");
		}
	}, []);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const save = async (key: ProviderKeyName) => {
		const value = (drafts[key] ?? "").trim();
		if (value.length < 8) return;
		setBusy(key);
		setError(null);
		try {
			await orpcFetch.yantra.setProviderKey({ key, value, installationWide });
			setDrafts((d) => ({ ...d, [key]: "" }));
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save the key");
		} finally {
			setBusy(null);
		}
	};

	const clear = async (key: ProviderKeyName) => {
		setBusy(key);
		setError(null);
		try {
			await orpcFetch.yantra.clearProviderKey({ key });
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not clear the key");
		} finally {
			setBusy(null);
		}
	};

	return (
		<Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
			<DialogTitle sx={{ fontWeight: 700 }}>Provider keys</DialogTitle>
			<DialogContent>
				{!state ? (
					<Stack alignItems="center" sx={{ py: 4 }}>
						{error ? (
							<Alert severity="error">{error}</Alert>
						) : (
							<CircularProgress size={22} />
						)}
					</Stack>
				) : (
					<Stack spacing={2} sx={{ mt: 0.5 }}>
						<Typography variant="caption" sx={{ color: "text.secondary" }}>
							Stored encrypted and never shown again — only the last four
							characters come back. Keys you set here belong to this team;
							anything you leave unset is inherited from the installation.
						</Typography>
						{error && <Alert severity="error">{error}</Alert>}

						{state.canEditInstallation && (
							<FormControlLabel
								control={
									<Switch
										size="small"
										checked={installationWide}
										onChange={(e) => setInstallationWide(e.target.checked)}
									/>
								}
								label={
									<Typography variant="caption">
										Save as the installation-wide key — changes what every team
										without its own key runs on.
									</Typography>
								}
							/>
						)}

						<Stack divider={<Divider />} spacing={0}>
							{state.known.map((key) => {
								const set = state.keys.find((k) => k.key === key);
								const label = LABELS[key] ?? { name: key, help: "" };
								const draft = (drafts[key] ?? "").trim();
								return (
									<Box key={key} sx={{ py: 1.75 }}>
										<Stack
											direction="row"
											spacing={1}
											alignItems="baseline"
											sx={{ flexWrap: "wrap" }}
										>
											<Typography variant="body2" sx={{ fontWeight: 600 }}>
												{label.name}
											</Typography>
											<Typography
												variant="caption"
												sx={{ color: set ? "success.main" : "text.secondary" }}
											>
												{set
													? `${set.teamOwned ? "this team" : "inherited"} · ••••${set.valueHint}`
													: "not set"}
											</Typography>
										</Stack>
										{label.help && (
											<Typography
												variant="caption"
												sx={{ color: "text.secondary", display: "block" }}
											>
												{label.help}
											</Typography>
										)}
										<Stack
											direction={{ xs: "column", sm: "row" }}
											spacing={1}
											sx={{ mt: 1 }}
											useFlexGap
										>
											<TextField
												size="small"
												type="password"
												placeholder={set ? "Replace…" : "Paste value"}
												value={drafts[key] ?? ""}
												onChange={(e) =>
													setDrafts((d) => ({ ...d, [key]: e.target.value }))
												}
												sx={{ flex: 1 }}
											/>
											<Button
												size="small"
												variant="outlined"
												disabled={busy === key || draft.length < 8}
												onClick={() => void save(key)}
											>
												{busy === key ? "Saving…" : "Save"}
											</Button>
											{set?.teamOwned && (
												<Button
													size="small"
													variant="text"
													color="error"
													disabled={busy === key}
													onClick={() => void clear(key)}
												>
													Use inherited
												</Button>
											)}
										</Stack>
									</Box>
								);
							})}
						</Stack>

						<Box sx={{ textAlign: "right", pb: 1 }}>
							<Button onClick={onClose}>Done</Button>
						</Box>
					</Stack>
				)}
			</DialogContent>
		</Dialog>
	);
}
