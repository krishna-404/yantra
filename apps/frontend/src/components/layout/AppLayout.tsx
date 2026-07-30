import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { useThemeMode } from "@connected-repo/ui-mui/theme/ThemeContext";
import type { SessionInfo } from "@frontend/contexts/UserContext";
import { userContext, useSessionInfo } from "@frontend/contexts/UserContext";
import { useWorkspace, WorkspaceProvider } from "@frontend/contexts/WorkspaceContext";
import { YantraProjectsProvider } from "@frontend/contexts/YantraProjectsContext";
import { useMediaQuery } from "@mui/material";
import Drawer from "@mui/material/Drawer";
import Fade from "@mui/material/Fade";
import { useTheme } from "@mui/material/styles";
import { useEffect, useState } from "react";
import { Outlet, useLoaderData } from "react-router";
import { AppBadgeSync } from "./AppBadgeSync";
import { OfflineBanner } from "./OfflineBanner";
import { YantraSidebar } from "./YantraSidebar";

const SIDEBAR_WIDTH = 264;

export const AppLayoutContent = () => {
	const { activeWorkspace } = useWorkspace();
	const sessionInfo = useSessionInfo();
	return (
		<Fade key={activeWorkspace.id} in timeout={300}>
			<Box sx={{ height: "100%", width: "100%" }}>
				<Outlet context={sessionInfo} />
			</Box>
		</Fade>
	);
};

/**
 * AppLayout — the Claude-style shell for the authenticated app: a single left
 * sidebar (projects + user/team) and a full-height main pane. No top navbar —
 * everything lives in the sidebar and teams switch from the user menu. The rail
 * collapses into a Drawer on mobile.
 */
export const AppLayout = () => {
	const theme = useTheme();
	const isMobile = useMediaQuery(theme.breakpoints.down("md"));
	const sessionInfo = useLoaderData() as SessionInfo;
	const { setThemeMode } = useThemeMode();
	const [navOpen, setNavOpen] = useState(false);

	useEffect(() => {
		if (sessionInfo.user?.themeSetting) {
			setThemeMode(sessionInfo.user.themeSetting);
		}
	}, [sessionInfo.user?.themeSetting, setThemeMode]);

	return (
		<userContext.Provider value={sessionInfo}>
			<WorkspaceProvider sessionInfo={sessionInfo}>
				<YantraProjectsProvider>
					<OfflineBanner />
					<AppBadgeSync />
					<Box
						sx={{
							display: "flex",
							height: "100vh",
							width: "100%",
							bgcolor: "background.default",
							overflow: "hidden",
						}}
					>
						{isMobile ? (
							<Drawer open={navOpen} onClose={() => setNavOpen(false)}>
								<Box sx={{ width: SIDEBAR_WIDTH, height: "100%" }}>
									<YantraSidebar onNavigate={() => setNavOpen(false)} />
								</Box>
							</Drawer>
						) : (
							<Box
								sx={{
									width: SIDEBAR_WIDTH,
									flexShrink: 0,
									borderRight: "1px solid",
									borderColor: "divider",
									height: "100%",
								}}
							>
								<YantraSidebar />
							</Box>
						)}

						<Box
							component="main"
							sx={{
								flex: 1,
								minWidth: 0,
								height: "100%",
								display: "flex",
								flexDirection: "column",
								overflow: "hidden",
							}}
						>
							{isMobile && (
								<Box
									sx={{
										display: "flex",
										alignItems: "center",
										gap: 1,
										px: 1.5,
										py: 1,
										borderBottom: "1px solid",
										borderColor: "divider",
									}}
								>
									<Button
										size="small"
										variant="text"
										onClick={() => setNavOpen(true)}
										sx={{ minWidth: 0, fontSize: "1.1rem" }}
									>
										☰
									</Button>
									<Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
										Yantra
									</Typography>
								</Box>
							)}
							<Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
								<AppLayoutContent />
							</Box>
						</Box>
					</Box>
				</YantraProjectsProvider>
			</WorkspaceProvider>
		</userContext.Provider>
	);
};
