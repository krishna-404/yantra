import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Container } from "@connected-repo/ui-mui/layout/Container";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { useWorkspace } from "@frontend/contexts/WorkspaceContext";
import SettingsIcon from "@mui/icons-material/Settings";
import { useNavigate, useParams } from "react-router";

export default function TeamDetailsPage() {
	const navigate = useNavigate();
	const { teamId } = useParams<{ teamId: string }>();
	const { teams } = useWorkspace();

	const team = teams.find((t) => t.id === teamId);

	if (!teamId || !team) {
		return (
			<Container maxWidth="lg" sx={{ py: 8, textAlign: "center" }}>
				<Typography variant="h4">Team not found</Typography>
				<Button onClick={() => navigate("/dashboard")} sx={{ mt: 2 }}>
					Back to Dashboard
				</Button>
			</Container>
		);
	}

	return (
		<Container maxWidth="lg" sx={{ py: 4 }}>
			<Box sx={{ mb: 6 }}>
				<Stack direction="row" justifyContent="space-between" alignItems="center">
					<Box>
						<Typography variant="h3" sx={{ fontWeight: 800 }}>
							{team.name}
						</Typography>
						<Typography variant="body1" color="text.secondary">
							Welcome to your team workspace.
						</Typography>
					</Box>
					<Button
						variant="outlined"
						startIcon={<SettingsIcon />}
						onClick={() => navigate(`/teams/${teamId}/settings`)}
						sx={{ borderRadius: 2 }}
					/>
				</Stack>
			</Box>
		</Container>
	);
}
