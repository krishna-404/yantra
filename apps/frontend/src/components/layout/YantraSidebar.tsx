import { Avatar } from "@connected-repo/ui-mui/data-display/Avatar";
import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { NovuInbox } from "@frontend/components/notifications/NovuInbox";
import { ProviderKeysDialog } from "@frontend/components/yantra/ProviderKeysDialog";
import { useSessionInfo } from "@frontend/contexts/UserContext";
import { useWorkspace } from "@frontend/contexts/WorkspaceContext";
import { useProjects } from "@frontend/contexts/YantraProjectsContext";
import { orpcFetch } from "@frontend/utils/orpc.client";
import {
	Alert,
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	TextField,
} from "@mui/material";
import { useState } from "react";
import { UserProfileMenu } from "./UserProfileMenu";

/**
 * The Yantra shell sidebar (Claude-style): wordmark, a "New project" action,
 * the project list, and the user/team control at the bottom. Rendered as a
 * permanent rail on desktop and inside a Drawer on mobile.
 */
export function YantraSidebar({ onNavigate }: { onNavigate?: () => void }) {
	const { projects, selectedId, select, reload } = useProjects();
	const { activeWorkspace } = useWorkspace();
	const session = useSessionInfo();
	const user = session.user;
	const [adding, setAdding] = useState(false);
	const [editingKeys, setEditingKeys] = useState(false);

	return (
		<Stack sx={{ height: "100%", bgcolor: "background.paper" }}>
			{/* Wordmark + notifications */}
			<Stack
				direction="row"
				alignItems="center"
				justifyContent="space-between"
				sx={{ px: 2.5, py: 2 }}
			>
				<Typography
					variant="subtitle1"
					sx={{ fontWeight: 700, letterSpacing: "-0.01em" }}
				>
					Yantra
				</Typography>
				<NovuInbox />
			</Stack>

			{/* New project */}
			<Box sx={{ px: 2, pb: 1 }}>
				<Button
					fullWidth
					variant="text"
					onClick={() => setAdding(true)}
					sx={{
						justifyContent: "flex-start",
						borderRadius: 2,
						color: "primary.main",
						fontWeight: 600,
						py: 0.9,
						px: 1.5,
						"&:hover": { bgcolor: "action.hover" },
					}}
				>
					+&nbsp;&nbsp;New project
				</Button>
			</Box>

			{/* Project list */}
			<Box sx={{ px: 1.5, pt: 1, flex: 1, minHeight: 0, overflowY: "auto" }}>
				<Typography
					variant="caption"
					sx={{
						px: 1.5,
						color: "text.secondary",
						fontWeight: 600,
						display: "block",
						mb: 0.5,
					}}
				>
					Projects
				</Typography>
				<Stack spacing={0.25} sx={{ mt: 0.5 }}>
					{projects.length === 0 && (
						<Typography variant="body2" sx={{ px: 1, py: 1, color: "text.secondary" }}>
							No projects yet.
						</Typography>
					)}
					{projects.map((p) => {
						const active = p.id === selectedId;
						return (
							<Box
								key={p.id}
								component="button"
								type="button"
								onClick={() => {
									select(p.id);
									onNavigate?.();
								}}
								sx={{
									textAlign: "left",
									border: "none",
									cursor: "pointer",
									borderRadius: 2,
									px: 1.5,
									py: 0.85,
									bgcolor: active ? "action.selected" : "transparent",
									"&:hover": {
										bgcolor: active ? "action.selected" : "action.hover",
									},
									transition: "background-color 0.12s ease",
								}}
							>
								<Typography variant="body2" noWrap sx={{ fontWeight: active ? 700 : 500 }}>
									{p.repo}
								</Typography>
								<Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
									{p.productionBranch || "main"} ← {p.baseBranch} · {p.mode}
								</Typography>
							</Box>
						);
					})}
				</Stack>
			</Box>

			{/* Provider keys — the credentials every run depends on. */}
			<Box sx={{ px: 2, pb: 1 }}>
				<Button
					fullWidth
					variant="text"
					onClick={() => setEditingKeys(true)}
					sx={{
						justifyContent: "flex-start",
						textTransform: "none",
						borderRadius: 2,
						color: "text.secondary",
						py: 0.75,
					}}
				>
					Provider keys
				</Button>
			</Box>

			{/* User / team */}
			<Box sx={{ borderTop: "1px solid", borderColor: "divider", p: 1.5 }}>
				<UserProfileMenu
					trigger={
						<Stack
							direction="row"
							spacing={1.25}
							alignItems="center"
							sx={{
								px: 1,
								py: 0.75,
								borderRadius: 2,
								cursor: "pointer",
								"&:hover": { bgcolor: "action.hover" },
							}}
						>
							<Avatar src={user?.image || undefined} sx={{ width: 32, height: 32 }}>
								{user?.name?.[0] || user?.email?.[0] || "U"}
							</Avatar>
							<Box sx={{ minWidth: 0, flex: 1 }}>
								<Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
									{user?.name || "You"}
								</Typography>
								<Typography variant="caption" noWrap sx={{ color: "text.secondary", display: "block" }}>
									{activeWorkspace.name}
								</Typography>
							</Box>
						</Stack>
					}
				/>
			</Box>

			<ProviderKeysDialog
				open={editingKeys}
				onClose={() => setEditingKeys(false)}
			/>

			<NewProjectDialog
				open={adding}
				onClose={() => setAdding(false)}
				onCreated={async (id) => {
					setAdding(false);
					await reload();
					select(id);
					onNavigate?.();
				}}
			/>
		</Stack>
	);
}

function NewProjectDialog({
	open,
	onClose,
	onCreated,
}: {
	open: boolean;
	onClose: () => void;
	onCreated: (id: string) => void;
}) {
	const [repo, setRepo] = useState("");
	const [baseBranch, setBaseBranch] = useState("staging");
	const [productionBranch, setProductionBranch] = useState("main");
	const [productionUrl, setProductionUrl] = useState("");
	const [stagingUrl, setStagingUrl] = useState("");
	const [ghToken, setGhToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const create = async () => {
		setBusy(true);
		setErr(null);
		try {
			const p = await orpcFetch.yantra.createProject({
				repo: repo.trim(),
				baseBranch: baseBranch.trim(),
				productionBranch: productionBranch.trim(),
				productionUrl: productionUrl.trim(),
				stagingUrl: stagingUrl.trim(),
				ghToken: ghToken.trim(),
			});
			setRepo("");
			setGhToken("");
			onCreated(p.id);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Couldn't add project");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
			<DialogTitle sx={{ fontWeight: 700 }}>New project</DialogTitle>
			<DialogContent>
				<Stack spacing={2} sx={{ mt: 0.5 }}>
					<TextField
						size="small"
						label="Repository (owner/name)"
						placeholder="krishna-404/yantra"
						value={repo}
						onChange={(e) => setRepo(e.target.value)}
						autoFocus
					/>
					<TextField
						size="small"
						label="Production branch"
						value={productionBranch}
						onChange={(e) => setProductionBranch(e.target.value)}
						helperText="Where verified work ships. Features branch from here."
					/>
					<TextField
						size="small"
						label="Production URL (optional)"
						placeholder="https://app.example.com"
						value={productionUrl}
						onChange={(e) => setProductionUrl(e.target.value)}
					/>
					<TextField
						size="small"
						label="Staging branch"
						value={baseBranch}
						onChange={(e) => setBaseBranch(e.target.value)}
						helperText="Every feature branch is checked here before promotion."
					/>
					<TextField
						size="small"
						label="Staging URL (optional)"
						placeholder="https://staging.example.com"
						value={stagingUrl}
						onChange={(e) => setStagingUrl(e.target.value)}
					/>
					<TextField
						size="small"
						type="password"
						label="GitHub token (PAT)"
						value={ghToken}
						onChange={(e) => setGhToken(e.target.value)}
						helperText="Stored encrypted, scoped to this project."
					/>
					{err && <Alert severity="error">{err}</Alert>}
					<Stack direction="row" spacing={1} justifyContent="flex-end">
						<Button onClick={onClose} disabled={busy} sx={{ textTransform: "none" }}>
							Cancel
						</Button>
						<Button
							variant="contained"
							onClick={() => void create()}
							disabled={busy || repo.trim().length < 3 || ghToken.trim().length < 20}
							sx={{ textTransform: "none" }}
						>
							{busy ? "Adding…" : "Add project"}
						</Button>
					</Stack>
				</Stack>
			</DialogContent>
		</Dialog>
	);
}
