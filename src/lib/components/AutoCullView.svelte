<script lang="ts">
    import {
        Check,
        ChevronLeft,
        Circle,
        CircleCheck,
        CircleDot,
        CornerDownLeft,
        Download,
        ListChecks,
        Loader2,
        Maximize2,
        PanelRight,
        Plus,
        RefreshCw,
        SkipForward,
        Sparkles,
        Star,
        TriangleAlert,
        Undo2,
        WandSparkles,
        X,
        XCircle,
    } from "@lucide/svelte";
    import { onDestroy, tick, untrack } from "svelte";
    import { createDecisionBook, type DecisionBook } from "../autocullDecisionBook.ts";
    import { saveDecisionBookFile } from "../decisionBookFile.ts";
    import {
        DEFAULT_PREFERENCE_PROFILE_ID,
        buildAutoCullSession,
        createPreferenceProfile,
        capturePreferenceFeatures,
        loadActivePreferenceProfileId,
        loadPairwisePreferences,
        loadPreferenceProfiles,
        loadPreferenceRefinements,
        saveActivePreferenceProfileId,
        savePreferenceFeedback,
        type AutoCullPreferenceRefinement,
        type AutoCullPreferenceProfile,
    } from "../autocull.ts";
    import {
        automaticPhotoIds,
        automaticFeedbackPhotoIds,
        buildAutoCullPlan,
        loadAutomaticDecisions,
        saveAutomaticDecisions,
        type AutomaticDecisions,
    } from "../autocullPlan.ts";
    import {
        adjacentStackKey,
        applyChanges,
        buildReviewQueue,
        canFinishStack,
        canKeepSuggested,
        filterQueue,
        decisionSignature,
        resolutionIsCurrent,
        isDecided,
        landingPhotoId,
        loadResolutions,
        nextPendingKey,
        normalizeDecision,
        pairedIds,
        planDecision,
        planKeepSelectedRejectRest,
        planKeepSuggested,
        pushHistory,
        replacedPairwise,
        restoreRefinements,
        revertPairwise,
        sameDecision,
        saveResolutions,
        snapshotRefinements,
        stackIssues,
        stackPairwise,
        stackStatus,
        suggestionReasons,
        summarizeProgress,
        trainingPreferences,
        undecidedOthers,
        withResolutions,
        type DecisionChange,
        type PhotoDecision,
        type ResolutionMap,
        type ReviewFilter,
        type ReviewSnapshot,
        type ReviewStack,
        type StackIssue,
        type StackResolution,
        type StackStatus,
        type StorageLike,
    } from "../autocullReview.ts";
    import { loadAutoCullLearner, saveAutoCullLearner, nativeLearnerAvailable } from "../autocullNative.ts";
    import { HologramAPI } from "../api.ts";
    import { photoStore, viewMode } from "../stores/photoStore.ts";
    import PhotoPreviewCard from "./PhotoPreviewCard.svelte";
    import type { AutoCullLabel, AutoCullLearner, AutoCullSession, Photo, PhotoDecisionHandler, VisualIndexProgress } from "../types.ts";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
        onOpenPreview: (
            photoIds: string[],
            selectedPhotoId: string,
            onConfirmCluster?: () => void,
            preloadPhotoIds?: string[],
            onDecision?: PhotoDecisionHandler,
        ) => void;
    }

    let { photos, allPhotos, onOpenPreview }: Props = $props();

    type Mode = "overview" | "review";
    const AUTO_LABEL = "AutoCull";

    let root = $state<HTMLElement | null>(null);
    let innerWidth = $state(1440);
    // Raw state: sessions and snapshots are replaced wholesale, never mutated in place.
    let session = $state.raw<AutoCullSession | null>(null);
    let progress = $state<VisualIndexProgress>({ current: 0, total: 0 });
    let isAnalyzing = $state(false);
    let status = $state("");
    let mode = $state<Mode>("overview");
    let selectedPhotoId = $state<string | null>(null);
    let filter = $state<ReviewFilter>("todo");
    let justCompleted = $state(false);
    let showDetails = $state(false);
    let preferenceProfiles = $state<AutoCullPreferenceProfile[]>([]);
    let activePreferenceProfileId = $state(DEFAULT_PREFERENCE_PROFILE_ID);
    let folderPath = $state<string | null>(null);
    let resolutions = $state.raw<ResolutionMap>({});
    let automatic = $state.raw<AutomaticDecisions>({});
    let history = $state.raw<ReviewSnapshot[]>([]);
    let decisionsSinceAnalysis = $state(0);
    let requestedLearner = $state<AutoCullLearner>(loadAutoCullLearner());
    let learnerFailure = $state("");
    let analysisInterrupted = $state(false);
    let advancedOpen = $state(false);
    const learnerAvailable = nativeLearnerAvailable();

    type PreparedDecisionBook = { book: DecisionBook; profileId: string; profileName: string; revision: number };
    type DecisionBookExport =
        | { kind: "idle" }
        | { kind: "preparing" }
        | { kind: "ready"; prepared: PreparedDecisionBook; error: string }
        | { kind: "saving"; prepared: PreparedDecisionBook }
        | { kind: "saved"; filename: string; labels: number; comparisons: number }
        | { kind: "error"; message: string };
    let decisionBookExport = $state.raw<DecisionBookExport>({ kind: "idle" });
    let decisionBookRevision = 0;

    // Plain variables: these coordinate async work and must not trigger effects.
    let loadedFolder: string | null | undefined = undefined;
    let lastAnalysisKey = "";
    let analysisRun = 0;
    let destroyed = false;

    const actualLearner = $derived(session?.learner?.engine ?? "builtin");
    const learnerMismatch = $derived(Boolean(session && actualLearner !== requestedLearner));
    const learnerBlocked = $derived(isAnalyzing || learnerMismatch || Boolean(learnerFailure) || analysisInterrupted);
    const learnerName = (learner: AutoCullLearner) => learner === "xgboost-native" ? "XGBoost" : "built-in";
    const wide = $derived(innerWidth >= 1024);
    const photosById = $derived(new Map(photos.map((photo) => [photo.id, photo])));
    // Paired RAW files are hidden from the display list but share every decision.
    const lookupById = $derived.by(() => {
        const map = new Map(allPhotos.map((photo) => [photo.id, photo]));
        for (const photo of photos) map.set(photo.id, photo);
        return map;
    });
    const recommendationsById = $derived(new Map((session?.photos ?? []).map((item) => [item.photo_id, item])));
    const queue = $derived(buildReviewQueue(photos, session));
    const stackByKey = $derived(new Map(queue.map((stack) => [stack.key, stack])));
    const stackByPhotoId = $derived(new Map(queue.flatMap((stack) => stack.photoIds.map((id) => [id, stack] as const))));
    const statusByKey = $derived(new Map(queue.map((stack) => [stack.key, stackStatus(stack, decisionOf, resolutionIsCurrent(stack, decisionOf, resolutions[stack.key]))])));
    const issuesByKey = $derived(new Map(queue.map((stack) => [stack.key, stackIssues(stack, recommendationsById)])));
    const reviewProgress = $derived(summarizeProgress(queue, statusOf, decisionOf));
    const currentStack = $derived(selectedPhotoId ? stackByPhotoId.get(selectedPhotoId) ?? null : null);
    const visibleQueue = $derived(filterQueue(queue, filter, statusOf, issuesOf, currentStack?.key ?? null));
    const todoCount = $derived(reviewProgress.stacks - reviewProgress.done);
    const issueCount = $derived(queue.filter((stack) => issuesOf(stack).length > 0).length);
    const filterOptions = $derived<[ReviewFilter, string, number][]>([
        ["all", "All", reviewProgress.stacks],
        ["todo", "To review", todoCount],
        ["issues", "Issues", issueCount],
    ]);
    const selectedPhoto = $derived(selectedPhotoId ? photosById.get(selectedPhotoId) ?? null : null);
    const selectedRec = $derived(selectedPhotoId ? recommendationsById.get(selectedPhotoId) ?? null : null);
    const selectedDecision = $derived(normalizeDecision(selectedPhoto));
    const completionVisible = $derived(reviewProgress.complete && (filter === "todo" || justCompleted));
    const finishCheck = $derived(currentStack ? canFinishStack(currentStack, decisionOf) : null);
    const rejectRestCount = $derived(
        currentStack && selectedPhotoId && currentStack.photoIds.length > 1
            ? undecidedOthers(currentStack, selectedPhotoId, lookupById).length
            : 0,
    );
    const activeProfileName = $derived(
        preferenceProfiles.find((profile) => profile.id === activePreferenceProfileId)?.name ?? "Default",
    );

    // ── Automatic pass ───────────────────────────────────────────────────────
    const automaticIds = $derived(automaticPhotoIds([...lookupById.values()], automatic));
    const plan = $derived(session ? buildAutoCullPlan(photos, [...lookupById.values()], session) : null);
    // Single-frame stacks complete on their own; only multi-frame stacks need a stored resolution.
    const planResolveKeys = $derived(
        (plan?.resolvedStackKeys ?? []).filter((key) => (stackByKey.get(key)?.photoIds.length ?? 0) > 1 && !resolutionIsCurrent(stackByKey.get(key)!, decisionOf, resolutions[key])),
    );
    // Closing stacks rides along with flag changes; on its own it is not worth a pass.
    const planReady = $derived(Boolean(plan && plan.changes.length > 0));
    /** Stacks still needing the photographer once the plan is applied. */
    const projectedPending = $derived.by(() => {
        if (!plan) return queue.filter((stack) => statusOf(stack) !== "done");
        const after = applyChanges(lookupById, plan.changes, "after");
        const resolvedAfter = new Set(planReady ? planResolveKeys : []);
        const decisionAfter = (id: string) => normalizeDecision(after.get(id));
        return queue.filter((stack) => stackStatus(stack, decisionAfter, resolvedAfter.has(stack.key) || resolutionIsCurrent(stack, decisionAfter, resolutions[stack.key])) !== "done");
    });
    const pendingStacks = $derived(queue.filter((stack) => statusOf(stack) !== "done"));
    const autoKeptIds = $derived(photos.filter((photo) => automaticIds.has(photo.id) && decisionOf(photo.id).flag === "pick").map((photo) => photo.id));
    const autoRejectedIds = $derived(photos.filter((photo) => automaticIds.has(photo.id) && decisionOf(photo.id).flag === "reject").map((photo) => photo.id));
    const overview = $derived.by(() => {
        if (planReady && plan) {
            return {
                applied: false,
                keepIds: plan.keepIds,
                rejectIds: plan.rejectIds,
                pending: projectedPending,
                undecided: plan.reviewIds.length,
                untouched: photos.length - plan.keepIds.length - plan.rejectIds.length - plan.reviewIds.length,
            };
        }
        return {
            applied: true,
            keepIds: autoKeptIds,
            rejectIds: autoRejectedIds,
            pending: pendingStacks,
            undecided: reviewProgress.photos - reviewProgress.decidedPhotos,
            untouched: 0,
        };
    });
    const lastLabel = $derived(history.at(-1)?.label ?? null);

    function decisionOf(id: string): PhotoDecision {
        return normalizeDecision(lookupById.get(id));
    }

    function statusOf(stack: ReviewStack): StackStatus {
        return statusByKey.get(stack.key) ?? "todo";
    }

    function issuesOf(stack: ReviewStack): StackIssue[] {
        return issuesByKey.get(stack.key) ?? [];
    }

    function storage(): StorageLike | null {
        return typeof localStorage === "undefined" ? null : localStorage;
    }

    function isAutomatic(id: string): boolean {
        return automaticIds.has(id);
    }

    function patchAutomatic(current: AutomaticDecisions, patch: Record<string, PhotoDecision | null>): AutomaticDecisions {
        const next = { ...current };
        for (const [id, value] of Object.entries(patch)) {
            if (value) next[id] = value;
            else delete next[id];
        }
        return next;
    }

    // ── Folder, profile and analysis lifecycle ───────────────────────────────

    $effect(() => {
        photos.length;
        photos[0]?.file_path;
        const folder = HologramAPI.getActiveFolderPath();
        if (folder === loadedFolder) return;
        untrack(() => resetForFolder(folder));
    });

    function resetForFolder(folder: string | null) {
        invalidateDecisionBook();
        loadedFolder = folder;
        folderPath = folder;
        analysisRun++;
        lastAnalysisKey = "";
        isAnalyzing = false;
        session = null;
        learnerFailure = "";
        analysisInterrupted = false;
        mode = "overview";
        selectedPhotoId = null;
        history = [];
        decisionsSinceAnalysis = 0;
        justCompleted = false;
        preferenceProfiles = loadPreferenceProfiles();
        activePreferenceProfileId = loadActivePreferenceProfileId();
        resolutions = loadResolutions(storage(), folder, activePreferenceProfileId, DEFAULT_PREFERENCE_PROFILE_ID);
        automatic = loadAutomaticDecisions(storage(), folder);
    }

    // Only structural changes (files, previews, folder, profile) re-analyze. Flags and
    // ratings are read live from the photos, so decisions never reorder the queue.
    function analysisInputKey(items: Photo[], profileId: string, folder: string | null, learner: AutoCullLearner): string {
        if (items.length === 0) return "";
        return [
            folder ?? "",
            profileId,
            learner,
            items.map((photo) => [
                photo.id,
                photo.file_path,
                photo.file_size,
                photo.modified_at,
                photo.thumbnail ? "t" : "n",
            ].join(":")).join("|"),
        ].join("::");
    }

    $effect(() => {
        const key = analysisInputKey(photos, activePreferenceProfileId, folderPath, requestedLearner);
        if (!key || key === lastAnalysisKey) return;
        const timeout = window.setTimeout(() => void runAnalysis(), 350);
        return () => window.clearTimeout(timeout);
    });

    onDestroy(() => {
        destroyed = true;
        analysisRun++;
    });

    async function runAnalysis() {
        invalidateDecisionBook();
        const input = photos;
        const library = allPhotos;
        const folder = folderPath;
        const profileId = activePreferenceProfileId;
        const learner = requestedLearner;
        lastAnalysisKey = analysisInputKey(input, profileId, folder, learner);
        if (input.length === 0) {
            session = null;
            return;
        }
        const runId = ++analysisRun;
        const isCurrent = () => runId === analysisRun && !destroyed;
        isAnalyzing = true;
        learnerFailure = "";
        analysisInterrupted = false;
        progress = { current: 0, total: input.length };
        try {
            const missingIds = await HologramAPI.findMissingPhotoIds(library);
            if (!isCurrent()) return;
            const missing = new Set(missingIds);
            const analysisPhotos = input.filter((photo) => !missing.has(photo.id));
            if (missing.size > 0) {
                // Files deleted outside Hologram leave the library. They are not taste signals.
                photoStore.removePhotos(missingIds);
                lastAnalysisKey = analysisInputKey(analysisPhotos, profileId, folder, learner);
                const stats = await HologramAPI.getPhotoStats(library.filter((photo) => !missing.has(photo.id)));
                if (!isCurrent()) return;
                photoStore.setStats(stats);
            }
            if (analysisPhotos.length === 0) {
                session = null;
                status = "No photos to analyze";
                return;
            }
            const refinements = loadPreferenceRefinements(profileId);
            const preferences = loadPairwisePreferences(profileId);
            const next = await buildAutoCullSession(
                analysisPhotos,
                preferences,
                (nextProgress) => {
                    if (isCurrent()) progress = nextProgress;
                },
                refinements,
                profileId === DEFAULT_PREFERENCE_PROFILE_ID,
                folder,
                // AutoCull's own flags are not the photographer's taste: never learn from them.
                automaticFeedbackPhotoIds({ photos: library, refinements, pairs: preferences, automatic }),
                profileId,
                learner,
                isCurrent,
            );
            if (!isCurrent()) return;
            session = next;
            decisionsSinceAnalysis = 0;
            const missingNote = missing.size > 0
                ? ` · ${missing.size} missing file${missing.size === 1 ? "" : "s"} left the library`
                : "";
            status = `${next.stats.indexed}/${next.stats.total} previews analyzed${missingNote}`;
        } catch (error) {
            if (isCurrent()) {
                status = error instanceof Error ? error.message : String(error);
                if (learner === "xgboost-native") {
                    learnerFailure = status;
                    advancedOpen = true;
                }
            }
        } finally {
            if (runId === analysisRun) isAnalyzing = false;
        }
    }

    function refreshAnalysis() {
        if (isAnalyzing) return;
        void runAnalysis();
    }

    function setLearner(learner: AutoCullLearner) {
        if (learner === requestedLearner) return;
        try { saveAutoCullLearner(learner); }
        catch {
            status = "Could not save the learner setting. Nothing changed.";
            return;
        }
        lastAnalysisKey = "";
        analysisRun++;
        isAnalyzing = false;
        learnerFailure = "";
        analysisInterrupted = true;
        requestedLearner = learner;
    }

    function invalidatePendingAnalysis() {
        if (!isAnalyzing) return;
        analysisRun++;
        isAnalyzing = false;
        analysisInterrupted = true;
    }

    function setPreferenceProfile(profileId: string) {
        if (!preferenceProfiles.some((profile) => profile.id === profileId)) return;
        if (profileId === activePreferenceProfileId) return;
        // Invalidate in-flight analysis for the old profile; the input key change schedules a new run.
        analysisRun++;
        isAnalyzing = false;
        learnerFailure = "";
        analysisInterrupted = true;
        history = [];
        invalidateDecisionBook();
        activePreferenceProfileId = profileId;
        saveActivePreferenceProfileId(profileId);
        resolutions = loadResolutions(storage(), folderPath, profileId, DEFAULT_PREFERENCE_PROFILE_ID);
        status = `Profile: ${preferenceProfiles.find((profile) => profile.id === profileId)?.name ?? "Default"}`;
    }

    function invalidateDecisionBook() {
        decisionBookRevision++;
        decisionBookExport = { kind: "idle" };
    }

    async function prepareDecisionBook() {
        if (isAnalyzing || decisionBookExport.kind === "preparing" || decisionBookExport.kind === "saving") return;
        const revision = ++decisionBookRevision;
        const profileId = activePreferenceProfileId;
        const profileName = preferenceProfiles.find((profile) => profile.id === profileId)?.name ?? "Default";
        decisionBookExport = { kind: "preparing" };
        try {
            const book = await createDecisionBook(profileId, allPhotos);
            if (revision !== decisionBookRevision || destroyed) return;
            decisionBookExport = { kind: "ready", prepared: { book, profileId, profileName, revision }, error: "" };
        } catch (error) {
            if (revision !== decisionBookRevision || destroyed) return;
            decisionBookExport = { kind: "error", message: error instanceof Error ? error.message : String(error) };
        }
    }

    async function saveDecisionBook() {
        if (decisionBookExport.kind !== "ready" || isAnalyzing) return;
        const prepared = decisionBookExport.prepared;
        const isCurrent = () => prepared.revision === decisionBookRevision && prepared.profileId === activePreferenceProfileId && !destroyed;
        if (!isCurrent()) return;
        decisionBookExport = { kind: "saving", prepared };
        try {
            const result = await saveDecisionBookFile({ book: prepared.book, isCurrent });
            if (!isCurrent()) return;
            decisionBookExport = result.kind === "saved"
                ? { kind: "saved", filename: result.filename, labels: prepared.book.summary.manual_decisions, comparisons: prepared.book.summary.comparisons }
                : { kind: "ready", prepared, error: "" };
        } catch (error) {
            if (!isCurrent()) return;
            decisionBookExport = { kind: "ready", prepared, error: error instanceof Error ? error.message : String(error) };
        }
    }

    function createProfile() {
        const name = window.prompt("New taste profile (used across all folders)");
        if (!name?.trim()) return;
        const profile = createPreferenceProfile(name);
        preferenceProfiles = loadPreferenceProfiles();
        setPreferenceProfile(profile.id);
    }

    // ── Selection and navigation ─────────────────────────────────────────────

    $effect(() => {
        if (!session) return;
        if (selectedPhotoId && stackByPhotoId.has(selectedPhotoId)) return;
        untrack(() => {
            const target = queue.find((stack) => statusOf(stack) !== "done") ?? queue[0];
            setSelected(target ? landingPhotoId(target) : null, true);
        });
    });

    function setSelected(photoId: string | null, reveal = false) {
        selectedPhotoId = photoId;
        if (!photoId) return;
        const index = photos.findIndex((photo) => photo.id === photoId);
        if (index >= 0) photoStore.setSelectedIndex(index);
        if (reveal) revealSelection(photoId);
    }

    function revealSelection(photoId: string) {
        void tick().then(() => {
            const stack = stackByPhotoId.get(photoId);
            for (const selector of [`[data-autocull-photo-id="${CSS.escape(photoId)}"]`, stack ? `[data-stack-key="${CSS.escape(stack.key)}"]` : ""]) {
                if (selector) root?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "nearest", inline: "nearest" });
            }
        });
    }

    function selectPhoto(photoId: string) {
        justCompleted = false;
        setSelected(photoId, true);
    }

    function selectStack(stack: ReviewStack) {
        justCompleted = false;
        setSelected(landingPhotoId(stack), true);
    }

    function selectStackByKey(key: string | null): boolean {
        const stack = key ? stackByKey.get(key) : null;
        if (!stack) return false;
        selectStack(stack);
        return true;
    }

    function stepStack(delta: 1 | -1) {
        if (selectStackByKey(adjacentStackKey(queue, visibleQueue, currentStack?.key ?? null, delta))) return;
        if (delta > 0) goToNextPending(currentStack?.key ?? null);
    }

    function stepFrame(delta: 1 | -1) {
        const stack = currentStack;
        if (!stack || !selectedPhotoId) return stepStack(delta);
        const index = stack.photoIds.indexOf(selectedPhotoId);
        const nextId = stack.photoIds[index + delta];
        if (nextId) {
            selectPhoto(nextId);
            return;
        }
        const key = adjacentStackKey(queue, visibleQueue, stack.key, delta);
        const next = key ? stackByKey.get(key) : null;
        if (!next) return;
        justCompleted = false;
        setSelected(delta > 0 ? next.photoIds[0] : next.photoIds[next.photoIds.length - 1], true);
    }

    /** Move to the next stack still needing review; show completion only when nothing is left. */
    function goToNextPending(fromKey: string | null, finishedKey: string | null = null) {
        const key = nextPendingKey(queue, fromKey, (stack) => (stack.key === finishedKey ? "done" : statusOf(stack)));
        if (key) {
            selectStackByKey(key);
            return;
        }
        if (reviewProgress.complete) {
            justCompleted = true;
            status = "Every stack has a decision";
        } else {
            status = "This is the last stack left to review";
        }
    }

    function startReview(photoId: string | null = null) {
        mode = "review";
        justCompleted = false;
        if (photoId && stackByPhotoId.has(photoId)) {
            const stack = stackByPhotoId.get(photoId)!;
            if (statusOf(stack) === "done") filter = "all";
            selectPhoto(photoId);
            return;
        }
        filter = "todo";
        const target = queue.find((stack) => statusOf(stack) !== "done");
        if (target) selectStack(target);
        else {
            filter = "all";
            if (selectedPhotoId) revealSelection(selectedPhotoId);
            else if (queue[0]) selectStack(queue[0]);
        }
    }

    function showOverview() {
        mode = "overview";
        showDetails = false;
    }

    // ── Decisions (all undoable) ─────────────────────────────────────────────

    function photoName(id: string): string {
        return lookupById.get(id)?.file_name ?? id;
    }

    interface CommitOptions {
        /** A stack the photographer finished: confirms its automatic flags and trains its keepers. */
        resolveStack?: ReviewStack | null;
        /** Photos the photographer explicitly acted on, even if the action changed nothing. */
        confirmIds?: string[];
        /** AutoCull's own pass: records provenance and never trains. */
        automaticPass?: { resolveKeys: string[] };
    }

    interface CommitResult {
        trained: number;
        reopened: number;
        confirmed: number;
    }

    /**
     * Apply decisions as one undo step. Human actions clear AutoCull provenance, train the
     * profile, and reopen finished stacks whose decisions they change (dropping the comparisons
     * that stack taught). The automatic pass only records provenance. Nothing re-analyzes.
     */
    function reportFeatureSave(saved: boolean) {
        if (!saved && !destroyed) status = "Your decision is saved, but cross-shoot learning could not be saved on this device. Refresh to retry.";
    }

    function commit(label: string, changes: DecisionChange[], options: CommitOptions = {}): CommitResult | null {
        const { resolveStack = null, confirmIds = [], automaticPass } = options;
        const folder = folderPath;
        const profileId = activePreferenceProfileId;
        const now = new Date().toISOString();
        const nextById = applyChanges(lookupById, changes, "after");
        const decisionAfter = (id: string) => normalizeDecision(nextById.get(id));

        const automaticPatch: Record<string, PhotoDecision | null> = {};
        let promoted: string[] = [];
        if (automaticPass) {
            for (const change of changes) automaticPatch[change.id] = change.after;
        } else {
            const touched = new Set([
                ...changes.map((change) => change.id),
                ...[...confirmIds, ...(resolveStack?.photoIds ?? [])].flatMap((id) => pairedIds(id, lookupById)),
            ]);
            for (const id of touched) if (Object.hasOwn(automatic, id)) automaticPatch[id] = null;
            const changed = new Set(changes.map((change) => change.id));
            // Confirmed without a change: the automatic flag becomes the photographer's own label.
            promoted = [...touched].filter((id) => automaticIds.has(id) && !changed.has(id));
        }

        const reopened = automaticPass
            ? []
            : [...new Set(changes.map((change) => stackByPhotoId.get(change.id)).filter((stack): stack is ReviewStack => Boolean(stack)))]
                .filter((stack) => stack.photoIds.length > 1
                    && stack.key !== resolveStack?.key
                    && resolutions[stack.key]
                    && decisionSignature(stack, decisionOf) !== decisionSignature(stack, decisionAfter));

        const added = resolveStack && !automaticPass ? trainingPreferences(resolveStack, decisionAfter, now) : [];
        const resolutionPatch: Record<string, StackResolution | null> = {};
        for (const stack of reopened) resolutionPatch[stack.key] = null;
        if (resolveStack) resolutionPatch[resolveStack.key] = { resolved_at: now, trained: added.length > 0, decision_signature: decisionSignature(resolveStack, decisionAfter) };
        for (const key of automaticPass?.resolveKeys ?? []) {
            const stack = stackByKey.get(key);
            if (stack) resolutionPatch[key] = { resolved_at: now, trained: false, decision_signature: decisionSignature(stack, decisionAfter) };
        }

        if (changes.length === 0 && !resolveStack && Object.keys(automaticPatch).length === 0 && Object.keys(resolutionPatch).length === 0) return null;

        const retrained = [...reopened, ...(resolveStack && !automaticPass ? [resolveStack] : [])];
        const currentPairwise = loadPairwisePreferences(profileId);
        const currentRefinements = loadPreferenceRefinements(profileId);
        const removed = retrained.flatMap((stack) => stackPairwise(currentPairwise, stack.photoIds));
        const removedSet = new Set(removed);
        const remaining = currentPairwise.filter((preference) => !removedSet.has(preference));
        const replaced = added.length ? replacedPairwise(remaining, added) : [];
        const refinementIds = automaticPass ? [] : [...changes.map((change) => change.id), ...promoted];

        const snapshot: ReviewSnapshot = {
            label,
            folderPath: folder,
            profileId,
            decisions: changes,
            automatic: Object.fromEntries(Object.keys(automaticPatch).map((id) => [id, automatic[id] ?? null])),
            refinements: refinementIds.length
                ? snapshotRefinements(currentRefinements, refinementIds)
                : {},
            pairwise: { added, replaced, removed },
            resolutions: Object.fromEntries(Object.keys(resolutionPatch).map((key) => [key, resolutions[key] ?? null])),
            selection: { photoId: selectedPhotoId },
        };

        if (refinementIds.length || added.length || removed.length) {
            const feedback: AutoCullPreferenceRefinement[] = refinementIds.map((id) => ({
                photo_id: id, ...decisionAfter(id), confidence: decisionAfter(id).flag === "none" ? 0.62 : 1,
                source: "manual_decision", updated_at: now,
            }));
            try {
                savePreferenceFeedback(profileId, [...currentRefinements, ...feedback], [...remaining, ...added]);
            } catch {
                status = "Could not save your taste profile. Nothing changed. Free device storage and try again.";
                return null;
            }
        }
        invalidatePendingAnalysis();
        invalidateDecisionBook();
        for (const id of refinementIds) {
            const photo = nextById.get(id);
            const analysis = recommendationsById.get(id) ?? recommendationsById.get(photo?.paired_with ?? "");
            if (photo && analysis) void capturePreferenceFeatures([photo], { photos: [{ ...analysis, photo_id: id }] }).then(reportFeatureSave);
        }
        if (added.length && resolveStack && session) {
            const members = resolveStack.photoIds.flatMap((id) => {
                const photo = nextById.get(id);
                return photo ? [photo] : [];
            });
            void capturePreferenceFeatures(members, session).then(reportFeatureSave);
        }
        for (const change of changes) {
            if (change.before.flag !== change.after.flag) photoStore.setPhotoFlag(change.id, change.after.flag);
            if (change.before.rating !== change.after.rating) photoStore.setPhotoRating(change.id, change.after.rating);
        }
        if (Object.keys(resolutionPatch).length) {
            resolutions = withResolutions(resolutions, resolutionPatch);
            saveResolutions(storage(), folder, profileId, resolutions);
        }
        if (Object.keys(automaticPatch).length) {
            automatic = patchAutomatic(automatic, automaticPatch);
            saveAutomaticDecisions(storage(), folder, automatic);
        }
        history = pushHistory(history, snapshot);
        if (!automaticPass) decisionsSinceAnalysis += 1;
        return { trained: added.length, reopened: reopened.length, confirmed: promoted.length };
    }

    function undo() {
        const entry = history.at(-1);
        if (!entry) {
            status = "Nothing to undo";
            return;
        }
        if (Object.keys(entry.refinements).length || entry.pairwise.added.length || entry.pairwise.removed.length) {
            try {
                savePreferenceFeedback(entry.profileId,
                    restoreRefinements(loadPreferenceRefinements(entry.profileId), entry.refinements),
                    [...revertPairwise(loadPairwisePreferences(entry.profileId), entry.pairwise.added, entry.pairwise.replaced), ...entry.pairwise.removed],
                );
            } catch {
                status = "Could not save undo. Nothing changed. Free device storage and try again.";
                return;
            }
        }
        invalidatePendingAnalysis();
        invalidateDecisionBook();
        history = history.slice(0, -1);
        const isActiveFolder = entry.folderPath === folderPath;
        const isActive = isActiveFolder && entry.profileId === activePreferenceProfileId;
        for (const change of entry.decisions) {
            const current = decisionOf(change.id);
            if (current.flag !== change.before.flag) photoStore.setPhotoFlag(change.id, change.before.flag);
            if (current.rating !== change.before.rating) photoStore.setPhotoRating(change.id, change.before.rating);
        }
        if (Object.keys(entry.resolutions).length) {
            const base = isActive ? resolutions : loadResolutions(storage(), entry.folderPath, entry.profileId, DEFAULT_PREFERENCE_PROFILE_ID);
            const restored = withResolutions(base, entry.resolutions);
            saveResolutions(storage(), entry.folderPath, entry.profileId, restored);
            if (isActive) resolutions = restored;
        }
        if (Object.keys(entry.automatic).length) {
            const base = isActiveFolder ? automatic : loadAutomaticDecisions(storage(), entry.folderPath);
            const restored = patchAutomatic(base, entry.automatic);
            saveAutomaticDecisions(storage(), entry.folderPath, restored);
            automatic = restored;
        }
        if (entry.label !== AUTO_LABEL) decisionsSinceAnalysis = Math.max(0, decisionsSinceAnalysis - 1);
        justCompleted = false;
        if (entry.selection.photoId && photosById.has(entry.selection.photoId)) setSelected(entry.selection.photoId, mode === "review");
        status = `Undid ${entry.label}`;
    }

    function describe(changes: DecisionChange[], verb: string): string {
        const displayed = changes.filter((change) => photosById.has(change.id));
        const pairNote = changes.length > displayed.length ? " (RAW + JPEG)" : "";
        if (displayed.length === 1) return `${verb} ${photoName(displayed[0].id)}${pairNote}`;
        return `${verb} ${displayed.length} photos${pairNote}`;
    }

    function outcomeNote(result: CommitResult): string {
        return [
            result.reopened ? " · finished stack reopened" : "",
            result.trained ? " · learned from this stack" : "",
        ].join("");
    }

    /** One human decision on one photo (and its RAW/JPEG partner), from the stage or the loupe. */
    function applyDecision(photoId: string, patch: Partial<PhotoDecision>, label: string, verb: string): boolean {
        const changes = planDecision([photoId], lookupById, patch);
        const result = commit(label, changes, { confirmIds: [photoId] });
        if (!result) return false;
        status = (changes.length ? describe(changes, verb) : `Confirmed ${photoName(photoId)}`) + outcomeNote(result);
        return true;
    }

    function decide(patch: Partial<PhotoDecision>, label: string, verb: string, advance = false) {
        if (!selectedPhotoId) return;
        if (applyDecision(selectedPhotoId, patch, label, verb) && advance) advanceAfterDecision();
    }

    function keep(advance = false) {
        decide({ flag: "pick" }, "keep", "Kept", advance);
    }

    function reject(advance = false) {
        decide({ flag: "reject" }, "reject", "Rejected", advance);
    }

    function clearDecision() {
        decide({ flag: "none", rating: 0 }, "clear", "Cleared");
    }

    function rate(rating: number, advance = false) {
        decide({ rating }, "rating", rating > 0 ? `Rated ${rating}★` : "Cleared rating for", advance);
    }

    /** Loupe keys commit through the same history, provenance and training path as the stage. */
    const loupeDecision: PhotoDecisionHandler = (photoId, patch) => {
        if (!lookupById.has(photoId)) return;
        if (stackByPhotoId.has(photoId)) selectedPhotoId = photoId;
        const verb = patch.flag === "pick" ? "Kept" : patch.flag === "reject" ? "Rejected" : patch.rating ? `Rated ${patch.rating}★` : "Cleared";
        applyDecision(photoId, patch, "loupe decision", verb);
    };

    const ENTER_HINT = " · Enter finishes this stack";

    /** Next frame in the stack; a decided single moves on to the next stack needing review. */
    function advanceAfterDecision() {
        const stack = currentStack;
        if (!stack || !selectedPhotoId) return;
        const nextId = stack.photoIds[stack.photoIds.indexOf(selectedPhotoId) + 1];
        if (nextId) {
            selectPhoto(nextId);
        } else if (stack.photoIds.length === 1) {
            if (statusOf(stack) === "done") goToNextPending(stack.key, stack.key);
        } else if (!resolutionIsCurrent(stack, decisionOf, resolutions[stack.key]) && !status.endsWith(ENTER_HINT)) {
            status = `${status}${ENTER_HINT}`;
        }
    }

    function keepSuggested() {
        const stack = currentStack;
        if (!stack?.suggestedId) return;
        const changes = planKeepSuggested(stack, lookupById);
        const result = commit("keep suggested", changes);
        if (result) status = describe(changes, "Kept suggested") + outcomeNote(result);
        setSelected(stack.suggestedId, true);
    }

    function keepSelectedRejectRest() {
        const stack = currentStack;
        const selected = selectedPhotoId;
        if (!stack || !selected || stack.photoIds.length < 2) return;
        const changes = planKeepSelectedRejectRest(stack, selected, lookupById);
        const rejected = changes.filter((change) => change.after.flag === "reject" && photosById.has(change.id)).length;
        const result = commit("keep selected & reject rest", changes, { resolveStack: stack, confirmIds: [selected] });
        if (!result) return;
        status = `Kept ${photoName(selected)}, rejected ${rejected} other${rejected === 1 ? "" : "s"}${result.trained ? " · learned from this stack" : ""}`;
        goToNextPending(stack.key, stack.key);
    }

    function stackHasAutomatic(stack: ReviewStack): boolean {
        return stack.photoIds.some((id) => pairedIds(id, lookupById).some(isAutomatic));
    }

    /** Enter: finish (or confirm AutoCull's choices for) the stack, then move to the next one. */
    function finishStack(stack: ReviewStack | null = currentStack) {
        if (!stack) return;
        const check = canFinishStack(stack, decisionOf);
        if (!check.ok) {
            status = check.reason;
            return;
        }
        const resolution = resolutions[stack.key];
        const confirming = stackHasAutomatic(stack);
        // Re-finishing confirms AutoCull's flags, or teaches a stack AutoCull closed without training.
        if (stack.photoIds.length > 1 && (!resolutionIsCurrent(stack, decisionOf, resolution) || confirming || (!resolution?.trained && stackHasPick(stack)))) {
            const result = commit(confirming ? "confirm stack" : "finish stack", [], { resolveStack: stack });
            if (!result) return;
            const keepers = stack.photoIds.filter((id) => decisionOf(id).flag === "pick").length;
            const verb = confirming ? "Confirmed AutoCull's choice" : "Finished";
            status = result?.trained
                ? `${verb} · learned that ${keepers} keeper${keepers === 1 ? "" : "s"} beat the rest`
                : confirming ? verb : "Finished stack";
        } else if (stack.photoIds.length === 1 && confirming) {
            const result = commit("confirm", [], { confirmIds: stack.photoIds });
            if (!result) return;
            if (result) status = `Confirmed ${photoName(stack.photoIds[0])}`;
        }
        goToNextPending(stack.key, stack.key);
    }

    function finishStackByKey(key: string) {
        finishStack(stackByKey.get(key) ?? null);
    }

    /** Move on without saving. Skipping never counts as finishing, even on the last open stack. */
    function skipStack() {
        const current = currentStack;
        const next = adjacentStackKey(queue, visibleQueue, current?.key ?? null, 1)
            ?? nextPendingKey(queue, current?.key ?? null, statusOf);
        if (selectStackByKey(next)) {
            status = "Skipped. Nothing saved";
            return;
        }
        status = current && statusOf(current) !== "done"
            ? "Skipped. This is the only stack left to review"
            : "Skipped. Nothing else to review";
    }

    function applyAutoCull() {
        if (!plan || !planReady || learnerBlocked) return;
        const kept = plan.keepIds.length;
        const rejected = plan.rejectIds.length;
        const result = commit(AUTO_LABEL, plan.changes, { automaticPass: { resolveKeys: planResolveKeys } });
        if (!result) return;
        const left = pendingStacks.length;
        status = `AutoCull kept ${kept}, rejected ${rejected} · ${left ? `${left} stack${left === 1 ? "" : "s"} left for you` : "nothing left to review"}`;
    }

    function openInLoupe(photoId: string) {
        const stack = stackByPhotoId.get(photoId);
        if (!stack) return;
        setSelected(photoId);
        const index = queue.findIndex((item) => item.key === stack.key);
        const following = queue
            .slice(index + 1)
            .flatMap((item) => item.photoIds)
            .slice(0, Math.max(0, 8 - stack.photoIds.length));
        const key = stack.key;
        onOpenPreview(stack.photoIds, photoId, stack.photoIds.length > 1 ? () => finishStackByKey(key) : undefined, following, loupeDecision);
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────

    function isTypingTarget(target: EventTarget | null): boolean {
        const element = target as HTMLElement | null;
        return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
    }

    function isActivatable(target: EventTarget | null): boolean {
        const element = target as HTMLElement | null;
        return !!element && ["BUTTON", "A", "SUMMARY"].includes(element.tagName);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.defaultPrevented || isTypingTarget(event.target) || $viewMode === "viewer") return;
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
            event.preventDefault();
            undo();
            return;
        }
        if (mod || event.altKey || !session) return;
        if (event.key === "Escape" && showDetails) {
            showDetails = false;
            return;
        }
        // The overview and the completion screen show no photo: decision keys would act unseen.
        if (mode !== "review" || completionVisible || !currentStack) return;
        // Let focused buttons keep their native Enter/Space activation.
        if ((event.key === "Enter" || event.key === " ") && isActivatable(event.target)) return;

        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        const actions: Record<string, () => void> = {
            ArrowRight: () => stepFrame(1),
            ArrowLeft: () => stepFrame(-1),
            ArrowDown: () => stepStack(1),
            ArrowUp: () => stepStack(-1),
            Enter: () => finishStack(),
            n: () => skipStack(),
            p: () => keep(true),
            x: () => reject(true),
            u: () => clearDecision(),
            s: () => keepSuggested(),
        };
        if (/^[0-5]$/.test(key)) {
            event.preventDefault();
            rate(Number(key), Number(key) > 0);
            return;
        }
        const action = actions[key];
        if (!action) return;
        event.preventDefault();
        action();
    }

    // Toolbar buttons keep keyboard focus on the page so Enter means "finish stack".
    function keepFocus(event: MouseEvent) {
        event.preventDefault();
    }

    // ── Display helpers ──────────────────────────────────────────────────────

    function kindLabel(stack: ReviewStack): string {
        if (stack.kind === "burst") return "Burst";
        if (stack.kind === "similar") return "Similar";
        return "Single";
    }

    function issueLabel(issue: StackIssue): string {
        if (issue === "preview-missing") return "Preview unavailable";
        if (issue === "low-quality") return "Low detail or exposure";
        return "Close call";
    }

    function suggestionBadge(label: AutoCullLabel | undefined): { text: string; cls: string } {
        switch (label) {
            case "SELECT":
                return { text: "Suggest keep", cls: "border-pick/40 bg-pick/10 text-pick" };
            case "MAYBE":
                return { text: "Maybe", cls: "border-maybe/40 bg-maybe/10 text-maybe" };
            case "REJECT":
                return { text: "Suggest reject", cls: "border-reject/40 bg-reject/10 text-reject" };
            case "NEEDS_REVIEW":
                return { text: "Needs review", cls: "border-info/40 bg-info/10 text-info" };
            default:
                return { text: "No suggestion", cls: "border-border text-muted-foreground" };
        }
    }

    function signalText(confidence: number): string {
        return confidence >= 0.8 ? "strong signal" : confidence >= 0.6 ? "moderate signal" : "limited signal";
    }

    function similarityText(value: number | null): string {
        if (value == null) return "";
        return value >= 0.85 ? "high" : value >= 0.7 ? "moderate" : "limited";
    }

    function formatTime(iso: string | null | undefined): string {
        if (!iso) return "";
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
            ? ""
            : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function stackTally(stack: ReviewStack): string {
        let kept = 0;
        let rejected = 0;
        for (const id of stack.photoIds) {
            const flag = decisionOf(id).flag;
            if (flag === "pick") kept++;
            if (flag === "reject") rejected++;
        }
        const tally = [kept ? `${kept} kept` : "", rejected ? `${rejected} rej` : ""].filter(Boolean).join(" · ");
        return tally && stackHasAutomatic(stack) ? `auto · ${tally}` : tally;
    }

    function scoreWidth(score: number): string {
        return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
    }

    function score10(score: number | undefined): string {
        return score == null ? "--" : (Math.max(0, Math.min(1, score)) * 10).toFixed(1);
    }

    function stackHasPick(stack: ReviewStack): boolean {
        return stack.photoIds.some((id) => decisionOf(id).flag === "pick");
    }

    function plural(count: number, word: string): string {
        return `${count} ${word}${count === 1 ? "" : "s"}`;
    }

    const shortcutMod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
</script>

<svelte:window onkeydown={handleKeydown} bind:innerWidth />

{#snippet deckLabel(text: string)}
    <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">{text}</div>
{/snippet}

{#snippet kbd(text: string)}
    <span class="rounded border border-white/15 px-1 font-mono text-[9.5px] font-medium leading-[15px] opacity-70">{text}</span>
{/snippet}

{#snippet decisionChip(decision: PhotoDecision, large: boolean, auto: boolean)}
    {#if decision.flag === "pick"}
        <span class="inline-flex items-center gap-1 rounded bg-pick font-mono font-bold text-black {large ? 'px-2 py-[3px] text-[11px]' : 'px-1.5 py-px text-[9px]'}"><Check size={large ? 12 : 10} />{auto ? "AUTO" : "KEPT"}</span>
    {:else if decision.flag === "reject"}
        <span class="inline-flex items-center gap-1 rounded bg-reject font-mono font-bold text-white {large ? 'px-2 py-[3px] text-[11px]' : 'px-1.5 py-px text-[9px]'}"><X size={large ? 12 : 10} />{auto ? "AUTO" : "REJECTED"}</span>
    {/if}
    {#if decision.rating > 0}
        <span class="inline-flex items-center gap-0.5 rounded bg-black/70 font-mono font-bold text-rating {large ? 'px-2 py-[3px] text-[11px]' : 'px-1 py-px text-[9px]'}">{decision.rating}<Star size={large ? 11 : 9} fill="currentColor" /></span>
    {/if}
{/snippet}

{#snippet thumbStrip(ids: string[], label: string)}
    {@const shown = ids.slice(0, 5)}
    <div class="mt-2.5 flex h-7 items-center gap-1 overflow-hidden">
        {#each shown as id (id)}
            {@const photo = photosById.get(id)}
            {#if photo}
                <button
                    class="h-7 w-10 shrink-0 overflow-hidden rounded-[3px] bg-black outline-offset-1 transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                    onclick={() => startReview(id)}
                    title="Inspect {photo.file_name} ({label})"
                    aria-label="Inspect {photo.file_name}"
                >
                    <PhotoPreviewCard {photo} detailMode="image" fit="cover" iconSize={10} showControls={false} containerClass="h-full w-full aspect-auto" />
                </button>
            {/if}
        {/each}
        {#if ids.length > shown.length}<span class="shrink-0 pl-0.5 font-mono text-[10px] text-subtle">+{ids.length - shown.length}</span>{/if}
    </div>
{/snippet}

{#snippet learnerStatus()}
    <div class="font-mono text-[10.5px] leading-[1.6] text-muted-foreground" data-autocull-session-learner={session ? actualLearner : "none"} data-autocull-requested-learner={requestedLearner}>
        {#if session}
            This analysis: {learnerName(actualLearner)}{actualLearner === "xgboost-native" ? " (experimental)" : ""}
            {#if session.learner?.engine === "xgboost-native"}
                <span> · {session.learner.training_rows} training rows · {session.learner.train_ms.toFixed(1)} ms</span>
                {#if session.learner.training_rows === 0}<p>No eligible feedback to train yet.</p>{/if}
            {/if}
        {/if}
        {#if learnerMismatch && isAnalyzing}<p class="text-info">Re-ranking with {learnerName(requestedLearner)}. Previous suggestions stay visible until analysis finishes.</p>{/if}
        {#if learnerFailure}
            <div class="mt-2 rounded-md border border-reject/30 bg-reject/5 p-2 text-[11px]" role="alert" data-autocull-learner-error>
                <p>XGBoost analysis failed. {learnerFailure}</p>
                <p class="mt-1">AutoCull will not apply previous suggestions until you retry or switch back.</p>
                <div class="mt-2 flex gap-3"><button class="underline" onclick={refreshAnalysis}>Retry</button><button class="underline" onclick={() => setLearner("builtin")}>Use built-in learner</button></div>
            </div>
        {:else if analysisInterrupted}
            <p class="mt-1 text-info">Analysis changed. <button class="underline" onclick={refreshAnalysis}>Refresh analysis</button> to update suggestions.</p>
        {/if}
    </div>
{/snippet}

{#snippet overviewScreen()}
    {@const o = overview}
    {@const decidedByAuto = o.keepIds.length + o.rejectIds.length}
    <div class="min-h-0 flex-1 overflow-y-auto" data-autocull-overview data-autocull-overview-state={o.applied ? "applied" : "preview"}>
        <div class="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 py-5">
            <div>
                {@render deckLabel(o.applied ? "AutoCull result" : "AutoCull pass")}
                <h2 class="text-[17px] font-semibold leading-snug text-foreground" data-autocull-headline>
                    {#if !o.applied}
                        {autoKeptIds.length + autoRejectedIds.length ? `${decidedByAuto} more photos ready for AutoCull` : `AutoCull can decide ${decidedByAuto} of ${photos.length} photos`}
                    {:else if o.pending.length === 0}
                        Every stack has a decision
                    {:else if decidedByAuto}
                        {plural(o.pending.length, "stack")} left for you
                    {:else}
                        Nothing AutoCull is sure enough about
                    {/if}
                </h2>
                <p class="mt-1 max-w-[560px] text-[12px] leading-relaxed text-muted-foreground">
                    {#if !o.applied}
                        Sharp singles and clear stack winners are kept; soft, clipped and near-duplicate frames are rejected. Close calls and missing previews wait for you. Flags only, one undo step.
                    {:else if o.pending.length}
                        Review the close calls and unclear frames. Changing or confirming an AutoCull flag makes it yours, and only your choices teach the profile.
                    {:else}
                        Flags are reversible with {shortcutMod}Z. Originals are never modified.
                    {/if}
                </p>
            </div>

            <div class="grid grid-cols-3 gap-2" data-autocull-plan>
                <div class="min-w-0 rounded-md border border-pick/25 bg-pick/5 p-3" data-autocull-plan-keep={o.keepIds.length}>
                    <div class="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-pick"><Check size={12} />{o.applied ? "Kept" : "Keep"}</div>
                    <div class="mt-1 font-mono text-[26px] font-bold leading-none text-foreground">{o.keepIds.length}</div>
                    <div class="mt-1 truncate text-[11px] text-muted-foreground">{o.applied ? "flagged by AutoCull" : "photos to flag"}</div>
                    {@render thumbStrip(o.keepIds, "keep")}
                </div>
                <div class="min-w-0 rounded-md border border-reject/25 bg-reject/5 p-3" data-autocull-plan-reject={o.rejectIds.length}>
                    <div class="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-reject"><X size={12} />{o.applied ? "Rejected" : "Reject"}</div>
                    <div class="mt-1 font-mono text-[26px] font-bold leading-none text-foreground">{o.rejectIds.length}</div>
                    <div class="mt-1 truncate text-[11px] text-muted-foreground">{o.applied ? "flagged by AutoCull" : "photos to flag"}</div>
                    {@render thumbStrip(o.rejectIds, "reject")}
                </div>
                <div class="min-w-0 rounded-md border border-info/25 bg-info/5 p-3" data-autocull-plan-review={o.pending.length}>
                    <div class="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-info"><ListChecks size={12} />Needs you</div>
                    <div class="mt-1 font-mono text-[26px] font-bold leading-none text-foreground">{o.pending.length}</div>
                    <div class="mt-1 truncate text-[11px] text-muted-foreground">{o.pending.length === 1 ? "stack" : "stacks"} · {plural(o.undecided, "photo")} undecided</div>
                    {@render thumbStrip(o.pending.map(landingPhotoId), "needs review")}
                </div>
            </div>

            {#if !o.applied && o.untouched > 0}
                <p class="-mt-1 font-mono text-[10.5px] text-subtle" data-autocull-untouched>{plural(o.untouched, "photo")} you already decided stay as they are.</p>
            {/if}

            <div class="flex flex-wrap items-center gap-2">
                {#if !o.applied}
                    <button
                        class="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                        onclick={applyAutoCull}
                        disabled={learnerBlocked}
                        title={learnerBlocked ? "Refresh the requested learner before applying these suggestions." : undefined}
                        data-autocull-apply
                    ><WandSparkles size={15} />Apply AutoCull</button>
                    <button
                        class="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        onclick={() => startReview()}
                    >Review manually instead</button>
                {:else}
                    <button
                        class="inline-flex h-9 items-center gap-2 rounded-md px-4 text-[13px] font-semibold transition-opacity hover:opacity-90 {o.pending.length ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}"
                        onclick={() => startReview()}
                        data-autocull-review-exceptions
                    ><ListChecks size={15} />{o.pending.length ? `Review ${plural(o.pending.length, "exception")}` : "Browse all stacks"}</button>
                    {#if lastLabel === AUTO_LABEL}
                        <button
                            class="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            onclick={undo}
                            data-autocull-undo-apply
                        ><Undo2 size={13} />Undo AutoCull</button>
                    {/if}
                {/if}
                {#if isAnalyzing}<span class="flex items-center gap-1.5 font-mono text-[10.5px] text-info"><Loader2 size={12} class="animate-spin" />Updating analysis</span>{/if}
            </div>

            {@render learnerStatus()}

            <p class="min-h-[15px] font-mono text-[10.5px] text-muted-foreground" role="status" aria-live="polite" data-autocull-status>{status}</p>

            <details class="group border-t border-border pt-3" data-autocull-rules>
                <summary class="cursor-pointer list-none font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle transition-colors hover:text-foreground">
                    <span class="inline-block transition-transform group-open:rotate-90">›</span> How AutoCull decides
                </summary>
                <ul class="mt-2 flex list-disc flex-col gap-1 pl-4 text-[11.5px] leading-relaxed text-muted-foreground">
                    <li>Only photos without a flag or rating are touched. Your existing decisions, and both halves of a RAW+JPEG pair, are left alone.</li>
                    <li>Singles are kept when the preview scores well and rejected when it is clearly soft or clipped. Anything in between waits for you.</li>
                    <li>In a burst, a clear winner is kept and its near-duplicates are rejected. Close calls stay open.</li>
                    <li>AutoCull's flags never train your taste profile. Confirm or change one in review and it becomes your decision.</li>
                </ul>
            </details>
        </div>
    </div>
{/snippet}

{#snippet inspector()}
    {@const stack = currentStack}
    {@const rec = selectedRec}
    <div class="flex flex-col gap-4 p-4" data-autocull-inspector>
        {#if selectedPhoto && stack}
            <section data-autocull-decision>
                {@render deckLabel("Your decision")}
                <div class="flex flex-wrap items-center gap-1.5">
                    {#if !isDecided(selectedDecision)}
                        <span class="rounded border border-border px-2 py-[3px] font-mono text-[11px] text-muted-foreground">No decision yet</span>
                    {:else}
                        {@render decisionChip(selectedDecision, true, false)}
                    {/if}
                    {#if isAutomatic(selectedPhoto.id)}
                        <span class="inline-flex items-center gap-1 rounded border border-primary/35 px-1.5 py-[2px] font-mono text-[10px] text-primary" data-autocull-provenance><WandSparkles size={11} />Set by AutoCull</span>
                    {/if}
                </div>
                <p class="mt-1.5 text-[11px] leading-[1.5] text-subtle">
                    {#if isAutomatic(selectedPhoto.id)}Not used for learning until you confirm or change it. {/if}{#if selectedPhoto.paired_with}Applies to both RAW and JPEG. {/if}Saved as you go. {shortcutMod}Z undoes.
                </p>
            </section>

            <section class="border-t border-border pt-3">
                {@render deckLabel("Suggestion")}
                {#if rec}
                    {@const badge = suggestionBadge(rec.recommendation)}
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="rounded border px-2 py-[3px] font-mono text-[11px] font-semibold {badge.cls}">{badge.text}</span>
                        <span class="font-mono text-[10.5px] text-muted-foreground" title="Heuristic strength of the suggestion, not a calibrated probability">{signalText(rec.confidence)}</span>
                    </div>
                    {#if stack.suggestedId === selectedPhoto.id}
                        <p class="mt-2 flex items-center gap-1.5 text-[11.5px] text-pick"><Sparkles size={12} />Suggested frame in this stack</p>
                    {:else if stack.suggestedId}
                        <button class="mt-2 flex items-center gap-1.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground" onmousedown={keepFocus} onclick={() => selectPhoto(stack.suggestedId!)}>
                            <Sparkles size={12} />Suggested: <span class="truncate font-mono text-[10.5px]">{photoName(stack.suggestedId)}</span>
                        </button>
                    {/if}
                    {#if stack.closeCall && !stackHasPick(stack)}
                        <p class="mt-2 rounded-md border border-info/25 bg-info/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground" data-autocull-close-call>
                            <span class="font-semibold text-info">Close call.</span> The leading frames score similarly. Compare expressions and focus before choosing a keeper.
                        </p>
                    {/if}
                    <ul class="mt-2.5 flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground" data-autocull-reasons>
                        {#each suggestionReasons(rec) as reason}<li>{reason}</li>{:else}<li>No analysis notes for this frame.</li>{/each}
                    </ul>
                    {#if decisionsSinceAnalysis > 0}
                        <p class="mt-2 font-mono text-[10px] leading-[1.5] text-subtle">From the last analysis. Refresh to include {decisionsSinceAnalysis} newer decision{decisionsSinceAnalysis === 1 ? "" : "s"}.</p>
                    {/if}
                {:else}
                    <p class="text-[11.5px] text-muted-foreground">{isAnalyzing ? "Analysis in progress…" : "Not analyzed yet."}</p>
                {/if}
            </section>

            <section class="border-t border-border pt-3">
                {@render deckLabel("Stack")}
                <div class="font-mono text-[11px] leading-[1.7] text-muted-foreground">
                    {kindLabel(stack)} · {stack.photoIds.length} frame{stack.photoIds.length === 1 ? "" : "s"}{#if formatTime(stack.startTime)} · {formatTime(stack.startTime)}{/if}<br />
                    {#if stack.similarity != null}Frame similarity: {similarityText(stack.similarity)}<br />{/if}
                    {#each issuesOf(stack) as issue}<span class="text-maybe">{issueLabel(issue)}</span><br />{/each}
                </div>
                {#if stack.similarity != null}
                    <p class="mt-1 text-[10.5px] leading-[1.5] text-subtle">Similarity describes the grouping, not the quality of the suggested frame.</p>
                {/if}
            </section>
        {/if}

        <details bind:open={advancedOpen} class="group border-t border-border pt-3" data-autocull-advanced>
            <summary class="cursor-pointer list-none font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle transition-colors hover:text-foreground">
                <span class="inline-block transition-transform group-open:rotate-90">›</span> Analysis &amp; taste profile
            </summary>
            <div class="mt-3 flex flex-col gap-4">
                {#if rec}
                    <div class="flex flex-col gap-2">
                        <div class="flex items-baseline gap-2">
                            <span class="font-mono text-[24px] font-bold leading-none text-foreground">{score10(rec.final_score)}</span>
                            <span class="font-mono text-[10.5px] text-subtle">final / 10</span>
                        </div>
                        <div>
                            <div class="mb-1 flex justify-between font-mono text-[10px] text-muted-foreground"><span>TECHNICAL</span><span class="text-foreground">{rec.embedding ? score10(rec.technical_score) : "Unavailable"}</span></div>
                            <div class="h-1 rounded-full bg-secondary"><div class="h-1 rounded-full bg-info" style:width={rec.embedding ? scoreWidth(rec.technical_score) : "0%"}></div></div>
                        </div>
                        <div>
                            <div class="mb-1 flex justify-between gap-2 font-mono text-[10px] text-muted-foreground"><span class="truncate">PERSONAL — {activeProfileName}</span><span class="text-foreground">{score10(rec.personal_score)}</span></div>
                            <div class="h-1 rounded-full bg-secondary"><div class="h-1 rounded-full bg-pick" style:width={scoreWidth(rec.personal_score)}></div></div>
                        </div>
                    </div>
                {/if}
                {#if session}
                    <div class="font-mono text-[10.5px] leading-[1.6] text-muted-foreground">
                        {session.stats.indexed}/{session.stats.total} previews analyzed<br />
                        {session.clusters.length} groups · {session.stats.training_examples} preferences learned
                        {#if session.stats.indexed < session.stats.total}
                            <span class="mt-1 block text-info">{session.stats.total - session.stats.indexed} {session.stats.total - session.stats.indexed === 1 ? "preview unavailable" : "previews unavailable"}. Review the originals before deciding.</span>
                        {/if}
                    </div>
                {/if}
                <div data-autocull-learner>
                    {@render deckLabel("Learner")}
                    <label class="flex items-start gap-2 text-[12px] font-medium text-foreground">
                        <input type="checkbox" class="mt-[3px] accent-primary" checked={requestedLearner === "xgboost-native"} disabled={!learnerAvailable} onchange={(event) => setLearner(event.currentTarget.checked ? "xgboost-native" : "builtin")} data-autocull-learner-toggle />
                        <span>Use XGBoost learner <span class="ml-1 rounded border border-maybe/40 px-1 font-mono text-[9px] text-maybe">EXPERIMENTAL</span></span>
                    </label>
                    <p class="mt-1 text-[11px] leading-[1.5] text-subtle">Same feedback, features and taste profile. Real culling choices have not been evaluated yet, so the built-in learner stays the default.</p>
                    {#if !learnerAvailable}<p class="mt-1 text-[11px] text-subtle">Available in the desktop app.</p>{/if}
                    {@render learnerStatus()}
                </div>
                <div>
                    {@render deckLabel("Taste profile · all shoots")}
                    <div class="flex flex-col gap-[2px]">
                        {#each preferenceProfiles as profile (profile.id)}
                            <button
                                class="flex items-center justify-between rounded-[5px] px-2 py-[5px] text-left text-[12px] font-medium transition-colors {activePreferenceProfileId === profile.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                                onclick={() => setPreferenceProfile(profile.id)}
                            >
                                <span class="truncate">{profile.name}</span>
                                {#if activePreferenceProfileId === profile.id}<span class="font-mono text-[10px] text-pick">active</span>{/if}
                            </button>
                        {/each}
                        <button class="flex items-center gap-1 px-2 py-[5px] text-left text-[12px] text-subtle transition-colors hover:text-foreground" onclick={createProfile}>
                            <Plus size={12} /> New profile
                        </button>
                    </div>
                    <p class="mt-1.5 px-1 text-[11px] italic leading-[1.5] text-subtle">Profiles are shared across every folder. Your keeps, rejects, ratings and finished stacks teach the active profile across shoots. AutoCull's own flags never do. Review progress stays with this folder and profile.</p>
                    <div class="mt-3 border-t border-border pt-2" data-autocull-decision-book>
                        <button
                            class="flex items-center gap-1.5 px-2 py-[5px] text-left text-[12px] text-subtle transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-50"
                            onclick={prepareDecisionBook}
                            disabled={isAnalyzing || decisionBookExport.kind === "preparing" || decisionBookExport.kind === "saving"}
                            data-autocull-prepare-decision-book
                        >
                            {#if decisionBookExport.kind === "preparing"}<Loader2 size={12} class="animate-spin" />{:else}<Download size={12} />{/if}
                            {decisionBookExport.kind === "preparing" ? "Reading saved reviews…" : "Export decision book…"}
                        </button>
                        <div aria-live="polite" class="px-2 text-[11px] leading-[1.5] text-subtle">
                            {#if decisionBookExport.kind === "ready" || decisionBookExport.kind === "saving"}
                                {@const prepared = decisionBookExport.prepared}
                                {@const summary = prepared.book.summary}
                                <div class="mt-1 rounded-md border border-border bg-background p-2" data-autocull-decision-book-summary>
                                    <p class="font-medium text-foreground">{prepared.profileName}</p>
                                    <p>{summary.manual_decisions} labels · {summary.comparisons} comparisons · {summary.photos} photos</p>
                                    <p>{summary.shoots} provisional shoots · {summary.datasets} feature datasets</p>
                                    {#each prepared.book.datasets as dataset}
                                        <p class="mt-1 break-words font-mono text-[10px]">{dataset.backend} · {dataset.photos.length} snapshots</p>
                                    {/each}
                                    {#if summary.omitted_decisions || summary.omitted_comparisons}
                                        <p class="mt-1 text-warning">{summary.omitted_decisions} labels and {summary.omitted_comparisons} comparisons omitted.</p>
                                        <p>{summary.unavailable_features} photos with missing or outdated features · {summary.missing_shoot} without a source group.</p>
                                        {#if summary.automatic_feedback}<p>{summary.automatic_feedback} photos still marked automatic were excluded.</p>{/if}
                                    {/if}
                                    <p class="mt-2">No original images or file paths. Derived features may reveal coarse image content. IDs are replaced for this file.</p>
                                    <p class="mt-1">Shoot groups come from source folders. Check that related frames stay together before using them as independent test splits.</p>
                                    {#if summary.manual_decisions + summary.comparisons === 0}
                                        <p class="mt-2 text-muted-foreground">No exportable human reviews yet. Review photos in this profile and retry. Reopen older shoots to restore missing source groups.</p>
                                    {/if}
                                    {#if decisionBookExport.kind === "ready" && decisionBookExport.error}
                                        <p role="alert" class="mt-2 text-reject">Could not save the decision book. {decisionBookExport.error}</p>
                                    {/if}
                                    <div class="mt-2 flex items-center gap-2">
                                        <button
                                            class="rounded-md bg-secondary px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
                                            onclick={saveDecisionBook}
                                            disabled={isAnalyzing || decisionBookExport.kind === "saving" || summary.manual_decisions + summary.comparisons === 0}
                                            data-autocull-save-decision-book
                                        >{decisionBookExport.kind === "saving" ? "Saving…" : "Save JSON"}</button>
                                        <button class="px-1 py-1 hover:text-foreground" onclick={invalidateDecisionBook} disabled={decisionBookExport.kind === "saving"} data-autocull-cancel-decision-book>Cancel</button>
                                    </div>
                                </div>
                            {:else if decisionBookExport.kind === "saved"}
                                <p class="mt-1 break-words" data-autocull-decision-book-saved>Saved {decisionBookExport.filename} · {decisionBookExport.labels} labels · {decisionBookExport.comparisons} comparisons.</p>
                            {:else if decisionBookExport.kind === "error"}
                                <p role="alert" class="mt-1 text-reject">Could not prepare the decision book. {decisionBookExport.message} Retry the export.</p>
                            {:else if decisionBookExport.kind === "idle"}
                                <p class="mt-1">Generate a local JSON book from this profile's saved human reviews and feature snapshots.</p>
                            {/if}
                        </div>
                    </div>
                </div>
            </div>
        </details>
    </div>
{/snippet}

<section bind:this={root} class="relative flex h-full min-h-0 flex-col bg-background" data-autocull-view data-autocull-mode={session ? mode : "loading"} data-autocull-active-learner={session ? actualLearner : "none"}>
    <!-- HEADER: mode · progress · filters · undo · refresh -->
    <header class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-card px-3 py-2">
        <div class="flex min-w-0 items-center gap-2.5">
            {#if session && mode === "review"}
                <button
                    class="inline-flex h-7 items-center gap-1 rounded-md pl-1 pr-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle transition-colors hover:bg-secondary hover:text-foreground"
                    onmousedown={keepFocus}
                    onclick={showOverview}
                    data-autocull-show-overview
                    aria-label="Back to AutoCull summary"
                    title="Back to the AutoCull summary"
                ><ChevronLeft size={13} />AutoCull</button>
            {:else}
                <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">AutoCull</span>
            {/if}
            <div
                class="h-1 w-20 overflow-hidden rounded-full bg-secondary xl:w-32"
                role="progressbar"
                aria-label="Stacks reviewed"
                aria-valuemin={0}
                aria-valuemax={reviewProgress.stacks}
                aria-valuenow={reviewProgress.done}
            >
                <div class="h-full rounded-full bg-pick transition-[width]" style:width={reviewProgress.stacks ? scoreWidth(reviewProgress.done / reviewProgress.stacks) : "0%"}></div>
            </div>
            <span class="whitespace-nowrap font-mono text-[11px] text-muted-foreground" data-autocull-progress>
                <span class="text-foreground">{reviewProgress.done}</span>/{reviewProgress.stacks} stacks
                <span class="hidden sm:inline">· {reviewProgress.decidedPhotos}/{reviewProgress.photos} photos</span>
            </span>
        </div>
        {#if session && mode === "review"}
            <div class="flex overflow-hidden rounded-md border border-border text-[11px] font-medium" role="group" aria-label="Queue filter">
                {#each filterOptions as [value, label, count] (value)}
                    <button
                        class="px-2.5 py-[5px] transition-colors {filter === value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}"
                        aria-pressed={filter === value}
                        data-filter={value}
                        onmousedown={keepFocus}
                        onclick={() => { filter = value; justCompleted = false; }}
                    >{label} <span class="font-mono text-[10px] text-subtle">{count}</span></button>
                {/each}
            </div>
        {/if}
        <div class="flex-1"></div>
        {#if isAnalyzing && session && mode === "review"}
            <span class="flex items-center gap-1.5 font-mono text-[10.5px] text-info"><Loader2 size={12} class="animate-spin" />{progress.current}/{progress.total}</span>
        {/if}
        <div class="flex items-center gap-1.5">
            <button
                class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                onmousedown={keepFocus}
                onclick={undo}
                disabled={history.length === 0}
                aria-label="Undo"
                aria-keyshortcuts="Control+Z Meta+Z"
                title={history.length ? `Undo ${lastLabel} (${shortcutMod}Z)` : "Nothing to undo"}
            ><Undo2 size={13} /><span class="hidden md:inline">Undo</span></button>
            <button
                class="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:opacity-50 {decisionsSinceAnalysis > 0 ? 'border-primary/40 text-primary hover:bg-primary/10' : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'}"
                onmousedown={keepFocus}
                onclick={refreshAnalysis}
                disabled={isAnalyzing || photos.length === 0}
                aria-label="Refresh analysis"
                title={decisionsSinceAnalysis > 0 ? `Re-rank with ${decisionsSinceAnalysis} newer decision${decisionsSinceAnalysis === 1 ? "" : "s"}` : "Re-run analysis"}
            >
                {#if isAnalyzing}<Loader2 size={13} class="animate-spin" />{:else}<RefreshCw size={13} />{/if}
                <span class="hidden md:inline">Refresh</span>
                {#if decisionsSinceAnalysis > 0}<span class="font-mono text-[10px]">{decisionsSinceAnalysis}</span>{/if}
            </button>
        </div>
    </header>

    {#if !session}
        <div class="grid flex-1 place-items-center px-8">
            {#if isAnalyzing}
                <div class="w-full max-w-xs text-center">
                    <div class="text-[13px] font-semibold text-foreground">Analyzing previews…</div>
                    <div class="mt-1 font-mono text-[11px] text-info">{progress.current}/{progress.total}</div>
                    <div class="mt-3 h-1 overflow-hidden rounded-full bg-secondary">
                        <div class="h-full rounded-full bg-info transition-[width]" style:width={progress.total ? scoreWidth(progress.current / progress.total) : "8%"}></div>
                    </div>
                    <p class="mt-3 text-[11.5px] leading-relaxed text-subtle">AutoCull previews what it would keep and reject. Nothing is flagged until you apply it.</p>
                </div>
            {:else if photos.length === 0}
                <div class="font-mono text-[11px] text-muted-foreground">No photos in this view.</div>
            {:else}
                <div class="flex flex-col items-center gap-3 text-center">
                    {#if status}<p class="max-w-sm text-[12px] text-muted-foreground">{status}</p>{/if}
                    {@render learnerStatus()}
                    <button class="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90" onclick={refreshAnalysis}>
                        <Sparkles size={16} /> Analyze {photos.length} photos
                    </button>
                </div>
            {/if}
        </div>
    {:else if mode === "overview"}
        {@render overviewScreen()}
    {:else}
        <div class="relative flex min-h-0 flex-1">
            <!-- QUEUE RAIL -->
            <nav class="flex w-[172px] shrink-0 flex-col border-r border-border bg-card xl:w-[232px]" aria-label="Review queue">
                <ol class="min-h-0 flex-1 overflow-y-auto py-1" data-autocull-queue>
                    {#each visibleQueue as stack (stack.key)}
                        {@const isCurrent = stack.key === currentStack?.key}
                        {@const stackState = statusOf(stack)}
                        {@const cover = photosById.get(landingPhotoId(stack))}
                        {@const tally = stackTally(stack)}
                        <li style="content-visibility: auto; contain-intrinsic-size: auto 48px;">
                            <button
                                class="flex w-full items-center gap-2 border-l-2 py-1.5 pl-1.5 pr-2 text-left transition-colors {isCurrent ? 'border-primary bg-secondary' : 'border-transparent hover:bg-accent'}"
                                data-stack-key={stack.key}
                                data-stack-status={stackState}
                                data-stack-kind={stack.kind}
                                aria-current={isCurrent ? "true" : undefined}
                                onmousedown={keepFocus}
                                onclick={() => selectStack(stack)}
                                title={`${kindLabel(stack)} · ${stack.photoIds.length} frame${stack.photoIds.length === 1 ? "" : "s"}`}
                            >
                                <span class="relative h-9 w-[52px] shrink-0 overflow-hidden rounded-[3px] bg-black {stackState === 'done' && !isCurrent ? 'opacity-55' : ''}">
                                    {#if cover}<PhotoPreviewCard photo={cover} detailMode="image" fit="cover" iconSize={12} showControls={false} containerClass="h-full w-full aspect-auto" />{/if}
                                    {#if stack.photoIds.length > 1}
                                        <span class="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 font-mono text-[9px] text-white/90">{stack.photoIds.length}</span>
                                    {/if}
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span class="flex items-center gap-1 text-[11.5px] font-medium {isCurrent ? 'text-foreground' : 'text-muted-foreground'}">
                                        {kindLabel(stack)}
                                        {#if issuesOf(stack).length}<TriangleAlert size={11} class="shrink-0 text-maybe" aria-label="Has issues" />{/if}
                                    </span>
                                    <span class="block truncate font-mono text-[9.5px] text-subtle">{tally || formatTime(stack.startTime) || cover?.file_name || ""}</span>
                                </span>
                                {#if stackState === "done"}
                                    <CircleCheck size={13} class="shrink-0 text-pick" aria-label="Reviewed" />
                                {:else if stackState === "partial"}
                                    <CircleDot size={13} class="shrink-0 text-maybe" aria-label="In progress" />
                                {:else}
                                    <Circle size={13} class="shrink-0 text-subtle" aria-label="To review" />
                                {/if}
                            </button>
                        </li>
                    {:else}
                        <li class="px-3 py-4 text-[11.5px] leading-relaxed text-muted-foreground">
                            {filter === "issues" ? "No issues found." : "Nothing left to review."}
                            <button class="mt-1 block text-primary hover:underline" onclick={() => (filter = "all")}>Show all stacks</button>
                        </li>
                    {/each}
                </ol>
            </nav>

            <!-- STAGE -->
            <main class="flex min-w-0 flex-1 flex-col">
                {#if completionVisible}
                    <div class="grid flex-1 place-items-center p-6" data-autocull-complete>
                        <div class="max-w-sm text-center">
                            <CircleCheck size={36} class="mx-auto text-pick" />
                            <h2 class="mt-3 text-[15px] font-semibold text-foreground">All {reviewProgress.stacks} stacks reviewed</h2>
                            <p class="mt-1.5 font-mono text-[11px] leading-[1.7] text-muted-foreground">
                                {reviewProgress.kept} kept · {reviewProgress.rejected} rejected · {reviewProgress.photos - reviewProgress.decidedPhotos} left unflagged
                                {#if autoKeptIds.length + autoRejectedIds.length}<br />{plural(autoKeptIds.length + autoRejectedIds.length, "flag")} set by AutoCull{/if}
                            </p>
                            <div class="mt-4 flex flex-wrap justify-center gap-2">
                                <button class="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:opacity-90" onclick={() => { filter = "all"; justCompleted = false; }}>Review all stacks</button>
                                <button class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground" onclick={showOverview}>Summary</button>
                                <button class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40" onclick={refreshAnalysis} disabled={isAnalyzing}><RefreshCw size={13} />Refresh analysis</button>
                            </div>
                            <p class="mt-3 font-mono text-[10px] text-subtle">Flags are reversible with {shortcutMod}Z. Originals are never modified.</p>
                        </div>
                    </div>
                {:else if selectedPhoto && currentStack}
                    {@const stack = currentStack}
                    {@const frameIndex = stack.photoIds.indexOf(selectedPhoto.id)}
                    <div class="relative min-h-0 flex-1 bg-canvas" data-autocull-stage>
                        <button class="absolute inset-0 block cursor-zoom-in" onmousedown={keepFocus} ondblclick={() => openInLoupe(selectedPhoto.id)} aria-label="Open {selectedPhoto.file_name} in loupe" title="Double-click to open the loupe">
                            <PhotoPreviewCard photo={selectedPhoto} detailMode="image" fit="contain" eager previewQuality="display" iconSize={28} showControls={false} containerClass="h-full w-full aspect-auto bg-canvas" />
                        </button>
                        <div class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
                            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                                <span class="truncate rounded bg-black/65 px-2 py-[3px] font-mono text-[10.5px] text-white/90">{selectedPhoto.file_name}</span>
                                {#if selectedPhoto.paired_with}<span class="rounded bg-black/65 px-1.5 py-[3px] font-mono text-[9.5px] text-white/70">RAW+JPEG</span>{/if}
                                {#if stack.photoIds.length > 1}<span class="rounded bg-black/65 px-1.5 py-[3px] font-mono text-[9.5px] text-white/70">{frameIndex + 1}/{stack.photoIds.length}</span>{/if}
                            </div>
                            <div class="flex shrink-0 items-center gap-1" data-autocull-stage-decision>
                                {@render decisionChip(selectedDecision, true, false)}
                                {#if isAutomatic(selectedPhoto.id)}<span class="rounded bg-black/65 px-1.5 py-[3px] font-mono text-[9.5px] text-primary">AUTO</span>{/if}
                            </div>
                        </div>
                        <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2.5">
                            <span class="max-w-[70%] truncate rounded bg-black/65 px-2 py-[3px] font-mono text-[10.5px] text-white/80" role="status" aria-live="polite" data-autocull-status>{status || "Ready"}</span>
                            <button class="pointer-events-auto inline-flex items-center gap-1 rounded bg-black/65 px-2 py-[3px] font-mono text-[10px] text-white/80 transition-colors hover:text-white" onmousedown={keepFocus} onclick={() => openInLoupe(selectedPhoto.id)}><Maximize2 size={11} />Loupe</button>
                        </div>
                    </div>

                    {#if !wide}
                        {@const badge = suggestionBadge(selectedRec?.recommendation)}
                        <div class="flex shrink-0 items-center gap-2 border-t border-border bg-card px-3 py-1.5 text-[11px]" data-autocull-suggestion-line>
                            <span class="shrink-0 rounded border px-1.5 py-px font-mono text-[10px] font-semibold {badge.cls}">{badge.text}</span>
                            {#if stack.closeCall && !stackHasPick(stack)}<span class="shrink-0 font-mono text-[10px] text-info">close call</span>{/if}
                            <span class="min-w-0 flex-1 truncate text-muted-foreground">{suggestionReasons(selectedRec)[0] ?? ""}</span>
                            <button class="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px text-[10.5px] text-muted-foreground hover:text-foreground" onmousedown={keepFocus} onclick={() => (showDetails = !showDetails)} aria-expanded={showDetails}><PanelRight size={12} />Details</button>
                        </div>
                    {/if}

                    {#if stack.photoIds.length > 1}
                        <div class="flex shrink-0 gap-1.5 overflow-x-auto border-t border-border bg-card px-3 py-2" data-autocull-filmstrip>
                            {#each stack.photoIds as id, index (id)}
                                {@const framePhoto = photosById.get(id)}
                                {@const frameDecision = decisionOf(id)}
                                {#if framePhoto}
                                    <button
                                        class="relative h-[56px] w-[84px] shrink-0 overflow-hidden rounded-[3px] border transition-all {selectedPhotoId === id ? 'border-transparent outline outline-2 -outline-offset-2 outline-primary' : 'border-border hover:border-ring'} {frameDecision.flag === 'reject' && selectedPhotoId !== id ? 'opacity-45' : ''}"
                                        data-autocull-photo-id={id}
                                        aria-label="Frame {index + 1}: {framePhoto.file_name}"
                                        aria-current={selectedPhotoId === id ? "true" : undefined}
                                        onmousedown={keepFocus}
                                        onclick={() => selectPhoto(id)}
                                        ondblclick={() => openInLoupe(id)}
                                    >
                                        <PhotoPreviewCard photo={framePhoto} detailMode="image" fit="cover" iconSize={14} showControls={false} containerClass="h-full w-full aspect-auto" />
                                        {#if stack.suggestedId === id}
                                            <span class="absolute left-1 top-1 rounded bg-black/70 px-1 font-mono text-[8.5px] font-bold text-pick" title="Suggested by the analysis">✦ SUGGESTED</span>
                                        {/if}
                                        <span class="absolute bottom-1 right-1 flex items-center gap-0.5">{@render decisionChip(frameDecision, false, isAutomatic(id))}</span>
                                        <span class="absolute bottom-1 left-1 font-mono text-[9px] text-white/75">{index + 1}</span>
                                    </button>
                                {/if}
                            {/each}
                        </div>
                    {/if}

                    <!-- ACTIONS -->
                    <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-card px-3 py-2" data-autocull-actions>
                        <button
                            class="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-bold transition-opacity hover:opacity-90 {selectedDecision.flag === 'pick' ? 'bg-pick text-black' : 'bg-pick/15 text-pick'}"
                            onmousedown={keepFocus}
                            onclick={() => keep()}
                            aria-label="Keep"
                            aria-keyshortcuts="P"
                            aria-pressed={selectedDecision.flag === "pick"}
                        ><Check size={14} />Keep {@render kbd("P")}</button>
                        <button
                            class="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-bold transition-opacity hover:opacity-90 {selectedDecision.flag === 'reject' ? 'bg-reject text-white' : 'bg-reject/15 text-reject'}"
                            onmousedown={keepFocus}
                            onclick={() => reject()}
                            aria-label="Reject"
                            aria-keyshortcuts="X"
                            aria-pressed={selectedDecision.flag === "reject"}
                        ><XCircle size={14} />Reject {@render kbd("X")}</button>
                        <button
                            class="inline-flex h-8 items-center gap-1.5 rounded-md bg-secondary px-2.5 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                            onmousedown={keepFocus}
                            onclick={clearDecision}
                            disabled={!isDecided(selectedDecision)}
                            aria-label="Clear"
                            aria-keyshortcuts="U"
                        ><Circle size={13} />Clear</button>
                        <div class="flex items-center gap-0.5" role="group" aria-label="Star rating">
                            {#each [1, 2, 3, 4, 5] as rating}
                                <button
                                    class="grid h-8 w-6 place-items-center rounded transition-colors {selectedDecision.rating >= rating ? 'text-rating' : 'text-subtle hover:text-rating'}"
                                    onmousedown={keepFocus}
                                    onclick={() => rate(selectedDecision.rating === rating ? 0 : rating)}
                                    aria-label="{rating} star{rating === 1 ? '' : 's'}"
                                    aria-keyshortcuts={`${rating}`}
                                ><Star size={14} fill={selectedDecision.rating >= rating ? "currentColor" : "none"} /></button>
                            {/each}
                        </div>
                        {#if stack.photoIds.length > 1}
                            <span class="mx-0.5 h-5 w-px bg-border"></span>
                            <button
                                class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                                onmousedown={keepFocus}
                                onclick={keepSuggested}
                                disabled={!canKeepSuggested(stack, lookupById)}
                                aria-label="Keep suggested"
                                aria-keyshortcuts="S"
                                title={stack.suggestedId ? "Keep the suggested frame. Its star rating is unchanged." : "No suggestion for this stack"}
                            ><Sparkles size={13} />Keep suggested {@render kbd("S")}</button>
                            {#if rejectRestCount > 0}
                                <button
                                    class="inline-flex h-8 items-center gap-1.5 rounded-md border border-reject/35 px-2.5 text-[11.5px] font-semibold text-foreground transition-colors hover:bg-reject/10"
                                    onmousedown={keepFocus}
                                    onclick={keepSelectedRejectRest}
                                    data-autocull-keep-reject-rest
                                    title="Keep this frame and reject the {rejectRestCount} frame{rejectRestCount === 1 ? '' : 's'} with no decision yet. Existing picks, ratings and rejects stay as they are. Undo with {shortcutMod}Z."
                                >Keep this &amp; reject {rejectRestCount} other{rejectRestCount === 1 ? "" : "s"}</button>
                            {/if}
                        {/if}
                        <div class="flex-1"></div>
                        <button
                            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            onmousedown={keepFocus}
                            onclick={skipStack}
                            aria-label="Skip"
                            aria-keyshortcuts="N"
                            title="Go to the next stack without saving anything"
                        ><SkipForward size={13} />Skip {@render kbd("N")}</button>
                        <button
                            class="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-bold transition-opacity {finishCheck?.ok ? 'bg-primary text-primary-foreground hover:opacity-90' : 'cursor-not-allowed bg-secondary text-subtle'}"
                            onmousedown={keepFocus}
                            onclick={() => finishStack()}
                            aria-disabled={!finishCheck?.ok}
                            aria-label={stack.photoIds.length > 1 ? "Finish stack" : "Next photo"}
                            aria-keyshortcuts="Enter"
                            title={finishCheck && !finishCheck.ok ? finishCheck.reason : stack.photoIds.length > 1 ? "Save this stack's choices (confirming any AutoCull flags) and go to the next stack" : "Go to the next photo needing review"}
                        >{stack.photoIds.length > 1 ? "Finish stack" : "Next"} <CornerDownLeft size={13} /></button>
                    </div>
                {:else}
                    <div class="grid flex-1 place-items-center font-mono text-[11px] text-muted-foreground">No photo selected.</div>
                {/if}
            </main>

            {#if wide}
                <aside class="w-[264px] shrink-0 overflow-y-auto border-l border-border bg-card xl:w-[300px]" aria-label="Decision and suggestion">
                    {@render inspector()}
                </aside>
            {:else if showDetails}
                <aside class="absolute inset-y-0 right-0 z-20 w-[280px] overflow-y-auto border-l border-border bg-card shadow-[-12px_0_32px_rgba(0,0,0,.45)]" aria-label="Decision and suggestion">
                    <button class="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-subtle hover:text-foreground" onclick={() => (showDetails = false)} aria-label="Close details"><X size={14} /></button>
                    {@render inspector()}
                </aside>
            {/if}
        </div>
    {/if}
</section>
