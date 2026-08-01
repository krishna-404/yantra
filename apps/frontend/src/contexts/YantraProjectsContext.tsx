import { orpcFetch } from "@frontend/utils/orpc.client";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

/**
 * Shared project state for the Yantra shell — the sidebar lists projects and
 * sets the active one; the main pane renders it. One fetch, one selection,
 * no route-param juggling.
 */

export interface YantraProject {
	id: string;
	repo: string;
	baseBranch: string;
	mode: string;
	enabled: boolean;
	ghTokenHint: string;
	autoMergeToMain: boolean;
}

interface ProjectsCtx {
	projects: YantraProject[];
	loading: boolean;
	selectedId: string;
	select: (id: string) => void;
	reload: () => Promise<void>;
}

const ctx = createContext<ProjectsCtx | null>(null);

export const useProjects = (): ProjectsCtx => {
	const c = useContext(ctx);
	if (!c) throw new Error("useProjects must be used within YantraProjectsProvider");
	return c;
};

export function YantraProjectsProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [projects, setProjects] = useState<YantraProject[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedId, setSelectedId] = useState("");

	const reload = useCallback(async () => {
		try {
			const rows = await orpcFetch.yantra.listProjects();
			setProjects(rows);
			setSelectedId((cur) => cur || rows[0]?.id || "");
		} catch {
			// swallow — the shell shows an empty state; errors surface on actions
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const value = useMemo(
		() => ({ projects, loading, selectedId, select: setSelectedId, reload }),
		[projects, loading, selectedId, reload],
	);

	return <ctx.Provider value={value}>{children}</ctx.Provider>;
}
