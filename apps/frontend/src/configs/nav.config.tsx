import { DashboardIcon } from "@connected-repo/ui-mui/icons/DashboardIcon";
import { GridViewIcon } from "@connected-repo/ui-mui/icons/GridViewIcon";
import { HomeIcon } from "@connected-repo/ui-mui/icons/HomeIcon";

interface NavItem {
	/** Display label for the nav item */
	label: string;
	/** Route path */
	path: string;
	/** Icon for desktop navbar */
	desktopIcon: React.ReactNode;
	/** Icon for mobile navbar (optional, defaults to desktopIcon) */
	mobileIcon?: React.ReactNode;
}

/**
 * Main navigation items for the application
 * Used by both DesktopNavbar and MobileNavbar
 */
export const navItems: NavItem[] = [
	{
		label: "Dashboard",
		path: "/dashboard",
		desktopIcon: <DashboardIcon fontSize="small" />,
		mobileIcon: <HomeIcon />, // Different icon for mobile
	},
	{
		// The factory cockpit (tenant-zero). Server-side super-admin gate —
		// non-admins see an access notice, so showing the entry is harmless.
		label: "Cockpit",
		path: "/yantra",
		desktopIcon: <GridViewIcon fontSize="small" />,
	},
];
