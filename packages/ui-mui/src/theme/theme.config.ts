import type { PaletteMode } from "@mui/material";
import { createTheme } from "@mui/material/styles";
import "./theme.types"; // Import type augmentations

/**
 * Design system — warm, restrained, premium (Claude-adjacent). One confident
 * accent (terracotta) over warm neutrals; generous radii; borders over heavy
 * shadows; a real weight hierarchy. Shared across light and dark.
 */

// The single brand accent, consistent across modes.
const ACCENT = "#c96442";
const ACCENT_LIGHT = "#d97757";
const ACCENT_DARK = "#b0512f";

const baseThemeConfig = {
	typography: {
		fontFamily: [
			"-apple-system",
			"BlinkMacSystemFont",
			'"Segoe UI"',
			"Inter",
			"Roboto",
			'"Helvetica Neue"',
			"Arial",
			"sans-serif",
		].join(","),
		h1: { fontSize: "2.5rem", fontWeight: 700, letterSpacing: "-0.02em" },
		h2: { fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.02em" },
		h3: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.015em" },
		h4: { fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.015em" },
		h5: { fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.01em" },
		h6: { fontSize: "1.05rem", fontWeight: 700, letterSpacing: "-0.01em" },
		subtitle1: { fontWeight: 600 },
		subtitle2: { fontWeight: 600 },
		button: { fontWeight: 600, letterSpacing: 0 },
		overline: { letterSpacing: "0.08em", fontWeight: 700 },
	},
	shape: {
		borderRadius: 10,
	},
	spacing: 8,
	components: {
		MuiCssBaseline: {
			styleOverrides: {
				body: {
					WebkitFontSmoothing: "antialiased",
					MozOsxFontSmoothing: "grayscale",
					// Slim, unobtrusive scrollbars — a small premium tell.
					"*::-webkit-scrollbar": { width: 10, height: 10 },
					"*::-webkit-scrollbar-thumb": {
						backgroundColor: "rgba(128,128,128,0.35)",
						borderRadius: 8,
						border: "2px solid transparent",
						backgroundClip: "content-box",
					},
					"*::-webkit-scrollbar-thumb:hover": {
						backgroundColor: "rgba(128,128,128,0.55)",
					},
					"*::-webkit-scrollbar-track": { backgroundColor: "transparent" },
				},
			},
		},
		MuiButton: {
			styleOverrides: {
				root: {
					textTransform: "none" as const,
					fontWeight: 600,
					borderRadius: 8,
					paddingInline: 14,
				},
				sizeSmall: { paddingInline: 12 },
			},
			defaultProps: { disableElevation: true },
		},
		MuiTextField: {
			defaultProps: {
				variant: "outlined" as const,
				size: "small" as const,
			},
		},
		MuiOutlinedInput: {
			styleOverrides: {
				root: {
					borderRadius: 10,
					// Claude's inputs read as a quiet surface, not a boxed control:
					// a hairline that only firms up on hover, and a single accent
					// ring on focus rather than a heavier double border.
					"& .MuiOutlinedInput-notchedOutline": {
						borderColor: "rgba(128,128,128,0.24)",
						transition: "border-color 0.12s ease",
					},
					"&:hover .MuiOutlinedInput-notchedOutline": {
						borderColor: "rgba(128,128,128,0.42)",
					},
					"&.Mui-focused .MuiOutlinedInput-notchedOutline": {
						borderWidth: 1,
						borderColor: ACCENT,
					},
				},
				input: {
					// Roomier than MUI's default — Claude's fields breathe.
					paddingTop: 11,
					paddingBottom: 11,
				},
			},
		},
		MuiInputLabel: {
			styleOverrides: {
				root: {
					fontSize: "0.875rem",
					"&.Mui-focused": { color: "inherit" },
				},
			},
		},
		MuiFormHelperText: {
			styleOverrides: {
				// Helper text is guidance, not chrome — pull it in and calm it down.
				root: { marginLeft: 2, marginTop: 6, lineHeight: 1.45 },
			},
		},
		MuiSwitch: {
			styleOverrides: {
				// MUI's default switch is chunky and very Material. Slimmer track,
				// smaller thumb, no ripple halo — closer to what Claude ships.
				root: { padding: 8 },
				track: { borderRadius: 11, opacity: 0.28 },
				thumb: { boxShadow: "0 1px 2px rgba(0,0,0,0.28)" },
			},
			defaultProps: { disableRipple: true },
		},
		MuiPaper: {
			// Kill MUI's dark-mode elevation overlay so surfaces are true-color.
			styleOverrides: { root: { backgroundImage: "none" } },
		},
		MuiCard: {
			styleOverrides: {
				root: {
					borderRadius: 14,
					border: "1px solid rgba(128,128,128,0.18)",
					boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
					backgroundImage: "none",
				},
			},
		},
		MuiDialog: {
			styleOverrides: { paper: { borderRadius: 16 } },
		},
		MuiMenu: {
			styleOverrides: { paper: { borderRadius: 12 } },
		},
		MuiAlert: {
			styleOverrides: { root: { borderRadius: 10 } },
		},
	},
};

/**
 * Creates a theme with the specified mode (light or dark).
 */
export const createAppTheme = (mode: PaletteMode = "light") => {
	return createTheme({
		...baseThemeConfig,
		palette: {
			mode,
			...(mode === "light"
				? {
						primary: {
							main: ACCENT,
							light: ACCENT_LIGHT,
							dark: ACCENT_DARK,
							lighter: "rgba(201, 100, 66, 0.08)",
							contrastText: "#ffffff",
						},
						secondary: {
							main: "#6b6760",
							light: "#8a857c",
							dark: "#4a4640",
							contrastText: "#fff",
						},
						success: {
							main: "#2f8f5b",
							light: "#4aa574",
							dark: "#227044",
							lighter: "rgba(47, 143, 91, 0.08)",
							contrastText: "#fff",
						},
						error: {
							main: "#c0392b",
							light: "#d15547",
							dark: "#9e2b20",
							lighter: "rgba(192, 57, 43, 0.08)",
							contrastText: "#fff",
						},
						warning: {
							main: "#c9820c",
							light: "#e0a53b",
							dark: "#a06800",
							contrastText: "#fff",
						},
						info: {
							main: "#3a7ca5",
							light: "#5a97bd",
							dark: "#2c627f",
							contrastText: "#fff",
						},
						background: {
							default: "#f4f3ee",
							paper: "#ffffff",
						},
						text: {
							primary: "#1f1e1d",
							secondary: "#6b6760",
							disabled: "#a7a29b",
						},
						divider: "rgba(31, 30, 29, 0.09)",
						action: {
							hover: "rgba(31, 30, 29, 0.04)",
							selected: "rgba(201, 100, 66, 0.10)",
						},
				  }
				: {
						primary: {
							main: ACCENT_LIGHT,
							light: "#e08c6f",
							dark: ACCENT,
							lighter: "rgba(217, 119, 87, 0.14)",
							contrastText: "#2b2a27",
						},
						secondary: {
							main: "#9b968e",
							light: "#b8b3aa",
							dark: "#6b6760",
							contrastText: "#1f1e1d",
						},
						success: {
							main: "#5bbb83",
							light: "#7cc99b",
							dark: "#3f9c66",
							lighter: "rgba(91, 187, 131, 0.14)",
							contrastText: "#1f1e1d",
						},
						error: {
							main: "#e07a6e",
							light: "#e8968c",
							dark: "#c0392b",
							lighter: "rgba(224, 122, 110, 0.14)",
							contrastText: "#1f1e1d",
						},
						warning: {
							main: "#e0a53b",
							light: "#e8ba63",
							dark: "#c9820c",
							contrastText: "#1f1e1d",
						},
						info: {
							main: "#6da8c9",
							light: "#8fbdd6",
							dark: "#3a7ca5",
							contrastText: "#1f1e1d",
						},
						background: {
							default: "#191816",
							paper: "#211f1d",
						},
						text: {
							primary: "#f4f3ef",
							secondary: "#9b968e",
							disabled: "#6b6760",
						},
						divider: "rgba(255, 255, 255, 0.08)",
						action: {
							hover: "rgba(255, 255, 255, 0.05)",
							selected: "rgba(217, 119, 87, 0.14)",
						},
				  }),
		},
	});
};

/**
 * Default light theme (for backwards compatibility)
 */
export const theme = createAppTheme("light");
