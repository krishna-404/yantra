import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Switch } from "@connected-repo/ui-mui/form/Switch";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Card } from "@connected-repo/ui-mui/layout/Card";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { usePwaInstallCtx } from "@frontend/components/notifications/PwaInstallHost";
import { getDeviceEnv } from "@frontend/utils/device.utils";
import {
	isPushEnabledOnThisDevice,
	promptAndRegisterPush,
	revokePushForUser,
} from "@frontend/utils/push.utils";
import InstallMobileIcon from "@mui/icons-material/InstallMobile";
import { useState } from "react";
import { toast } from "react-toastify";

const permissionLabel = () => {
	if (typeof Notification === "undefined") return "unsupported";
	return Notification.permission;
};

export const NotificationSettings = () => {
	const pwa = usePwaInstallCtx();
	const device = getDeviceEnv();
	const needsInstallFirst = device.isIOS && !device.isStandalone;

	const [pushOn, setPushOn] = useState(isPushEnabledOnThisDevice);
	const [pushPending, setPushPending] = useState(false);

	const handleTogglePush = async (nextOn: boolean) => {
		// App is online-first, offline-partially-available. The push toggle
		// requires a live backend round-trip either way (register or revoke),
		// and — critically for the ON path — calling Notification.requestPermission()
		// while the network is dead can leave the browser in a permission-default
		// state that never gets a follow-up register. Refuse fast, don't prompt.
		if (nextOn && typeof navigator !== "undefined" && !navigator.onLine) {
			toast.info("You're offline. Reconnect to change push settings.");
			return;
		}
		setPushPending(true);
		try {
			if (nextOn) {
				const result = await promptAndRegisterPush();
				if (result === "granted") {
					setPushOn(true);
					toast.success("Push notifications enabled");
				} else if (result === "denied") {
					toast.info(
						"Push is blocked by the browser. Enable it in site settings, then try again.",
					);
					setPushOn(false);
				} else {
					toast.info("Push is not supported in this browser.");
					setPushOn(false);
				}
			} else {
				await revokePushForUser({ stickyOptOut: true });
				setPushOn(false);
				toast.success("Push notifications disabled on this device");
			}
		} finally {
			setPushPending(false);
		}
	};

	return (
		<Card
			sx={{
				p: 3,
				borderRadius: 2,
				border: "1px solid",
				borderColor: "divider",
			}}
		>
			<Stack spacing={2}>
				<Box>
					<Typography variant="h6" sx={{ fontWeight: 700 }}>
						Notifications
					</Typography>
					<Typography variant="body2" color="text.secondary">
						Push notifications are per-device. In-app notifications land in
						the bell regardless.
					</Typography>
				</Box>

				<Stack
					direction="row"
					alignItems="center"
					justifyContent="space-between"
					sx={{ py: 1 }}
				>
					<Box>
						<Typography variant="body1" sx={{ fontWeight: 600 }}>
							Push notifications on this device
						</Typography>
						<Typography variant="caption" color="text.secondary">
							{needsInstallFirst
								? "iOS Safari needs the app installed to home screen to receive push. Install below, then re-open Settings."
								: `Browser permission: ${permissionLabel()}`}
						</Typography>
					</Box>
					{needsInstallFirst ? (
						<Button
							variant="outlined"
							size="small"
							startIcon={<InstallMobileIcon />}
							onClick={() => void pwa.install()}
						>
							Install app
						</Button>
					) : (
						<Switch
							checked={pushOn}
							disabled={pushPending}
							onChange={(e) => handleTogglePush(e.target.checked)}
						/>
					)}
				</Stack>

				{!needsInstallFirst && !device.isStandalone && pushOn && (
					<Stack
						direction="row"
						alignItems="center"
						justifyContent="space-between"
						sx={{ py: 1 }}
					>
						<Box>
							<Typography variant="body2" color="text.secondary">
								Add the app to your home screen for a native-app feel with its
								own window and icon.
							</Typography>
						</Box>
						<Button
							variant="text"
							size="small"
							startIcon={<InstallMobileIcon />}
							onClick={() => void pwa.install()}
						>
							Install
						</Button>
					</Stack>
				)}
			</Stack>
		</Card>
	);
};
