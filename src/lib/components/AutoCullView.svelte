<script lang="ts">
    import {
        Check,
        Circle,
        Loader2,
        Maximize2,
        Plus,
        RefreshCw,
        Sparkles,
        Star,
        XCircle,
    } from "@lucide/svelte";
    import { tick } from "svelte";
    import {
        DEFAULT_PREFERENCE_PROFILE_ID,
        addPairwisePreferences,
        buildAutoCullSession,
        createPreferenceProfile,
        loadActivePreferenceProfileId,
        loadPairwisePreferences,
        loadPreferenceProfiles,
        loadPreferenceRefinements,
        recordPreferenceRefinement,
        saveActivePreferenceProfileId,
        type AutoCullPreferenceProfile,
    } from "../autocull.ts";
    import { HologramAPI } from "../api.ts";
    import { photoStore } from "../stores/photoStore.ts";
    import PhotoPreviewCard from "./PhotoPreviewCard.svelte";
    import type {
        AutoCullCluster,
        AutoCullLabel,
        AutoCullPairwisePreference,
        AutoCullPhoto,
        AutoCullSession,
        CullFlag,
        Photo,
        VisualIndexProgress,
    } from "../types.ts";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
        onOpenPreview: (
            photoIds: string[],
            selectedPhotoId: string,
            onConfirmCluster?: () => void,
            preloadPhotoIds?: string[],
        ) => void;
    }

    let { photos, allPhotos, onOpenPreview }: Props = $props();

    let session = $state<AutoCullSession | null>(null);
    let progress = $state<VisualIndexProgress>({ current: 0, total: 0 });
    let isAnalyzing = $state(false);
    let selectedPhotoId = $state<string | null>(null);
    let activeClusterId = $state<string | null>(null);
    let lastAnalysisKey = $state("");
    let status = $state("Ready");
    let rejectThreshold = $state(0.42);
    let reviewMode = $state<"bursts" | "all">("bursts");
    let analysisRun = 0;
    let preferenceProfiles = $state<AutoCullPreferenceProfile[]>([]);
    let activePreferenceProfileId = $state("default");
    let preferenceProfileFolderPath = $state<string | null | undefined>(undefined);

    const photosById = $derived(new Map(photos.map((photo) => [photo.id, photo])));
    const allPhotosById = $derived(new Map(allPhotos.map((photo) => [photo.id, photo])));
    const recommendationsById = $derived(new Map((session?.photos ?? []).map((photo) => [photo.photo_id, photo])));
    const rankedRecommendations = $derived(
        [...(session?.photos ?? [])].sort((a, b) => a.final_score - b.final_score),
    );
    const clusterList = $derived(
        [...(session?.clusters ?? [])].sort((a, b) => {
            const kindDelta = clusterKindRank(a.kind) - clusterKindRank(b.kind);
            if (kindDelta !== 0) return kindDelta;
            return b.confidence - a.confidence;
        }),
    );
    const activeCluster = $derived(
        session?.clusters.find((cluster) => cluster.id === activeClusterId)
            ?? session?.clusters.find((cluster) => cluster.photo_ids.includes(selectedPhotoId ?? ""))
            ?? clusterList[0]
            ?? null,
    );
    const clusterPhotos = $derived(
        activeCluster ? activeCluster.photo_ids.map((id) => photosById.get(id)).filter((photo): photo is Photo => Boolean(photo)) : [],
    );
    const selectedPhoto = $derived(
        (selectedPhotoId ? photosById.get(selectedPhotoId) : null)
            ?? (activeCluster?.top_pick_id ? photosById.get(activeCluster.top_pick_id) : null)
            ?? photos[0]
            ?? null,
    );
    const selectedRecommendation = $derived(
        selectedPhoto ? recommendationsById.get(selectedPhoto.id) ?? null : null,
    );
    const rejectCandidates = $derived(
        (session?.photos ?? []).filter((item) => {
            const photo = photosById.get(item.photo_id);
            return item.recommendation === "REJECT"
                && item.final_score <= rejectThreshold
                && (photo?.flag ?? "none") === "none";
        }),
    );
    const burstCount = $derived(session?.clusters.length ?? 0);

    function revealSelectedPhoto(photoId: string) {
        void tick().then(() => {
            const rows = document.querySelectorAll<HTMLElement>("[data-autocull-photo-id]");
            for (const row of rows) {
                if (row.dataset.autocullPhotoId === photoId) {
                    row.scrollIntoView({ block: "nearest", inline: "nearest" });
                    return;
                }
            }
        });
    }

    function setSelectedPhoto(photoId: string | null, reveal = false) {
        selectedPhotoId = photoId;
        if (!photoId) return;
        const index = photos.findIndex((photo) => photo.id === photoId);
        if (index >= 0) photoStore.setSelectedIndex(index);
        if (reveal) revealSelectedPhoto(photoId);
    }

    $effect(() => {
        photos.length;
        photos[0]?.file_path;
        loadPreferenceProfileState();
    });

    $effect(() => {
        const firstId = photos[0]?.id ?? null;
        if (!selectedPhotoId || !photosById.has(selectedPhotoId)) {
            setSelectedPhoto(firstId);
        }
    });

    $effect(() => {
        const key = analysisInputKey();
        if (!key || key === lastAnalysisKey) return;
        const timeout = window.setTimeout(() => {
            lastAnalysisKey = key;
            void runAnalysis();
        }, 350);
        return () => window.clearTimeout(timeout);
    });

    function analysisInputKey(): string {
        return [
            activePreferenceProfileId,
            photos
            .map((photo) => [
                photo.id,
                photo.file_path,
                photo.file_size,
                photo.modified_at,
                photo.thumbnail ? "t" : "n",
            ].join(":"))
            .join("|"),
        ].join("::");
    }

    async function runAnalysis() {
        if (photos.length === 0) return;
        const runId = ++analysisRun;
        isAnalyzing = true;
        status = "Analyzing";
        progress = { current: 0, total: photos.length };
        try {
            const folderPath = HologramAPI.getActiveFolderPath();
            const missingIds = await HologramAPI.findMissingPhotoIds(allPhotos);
            const missing = new Set(missingIds);
            if (missing.size > 0) {
                for (const photo of allPhotos) {
                    if (!missing.has(photo.id)) continue;
                    recordPreferenceRefinement(
                        folderPath,
                        activePreferenceProfileId,
                        photo.id,
                        "reject",
                        0,
                        photo,
                        recommendationsById.get(photo.id),
                    );
                }
                photoStore.removePhotos(missingIds);
                const remainingPhotos = allPhotos.filter((photo) => !missing.has(photo.id));
                photoStore.setStats(await HologramAPI.getPhotoStats(remainingPhotos));
            }
            const preferences = loadPairwisePreferences(folderPath, activePreferenceProfileId);
            const refinements = loadPreferenceRefinements(folderPath, activePreferenceProfileId);
            const analysisPhotos = photos.filter((photo) => !missing.has(photo.id));
            if (analysisPhotos.length === 0) {
                session = null;
                status = missing.size > 0 ? `Learned from ${missing.size} deleted photo${missing.size === 1 ? "" : "s"}` : "No photos to analyze";
                return;
            }
            const next = await buildAutoCullSession(
                analysisPhotos,
                preferences,
                (nextProgress) => {
                    if (runId === analysisRun) progress = nextProgress;
                },
                refinements,
                activePreferenceProfileId === DEFAULT_PREFERENCE_PROFILE_ID,
                folderPath,
            );
            if (runId !== analysisRun) return;
            session = next;
            if (next.clusters.length === 0) reviewMode = "all";
            activeClusterId = next.clusters.find((cluster) => cluster.photo_ids.includes(selectedPhotoId ?? ""))?.id
                ?? next.clusters[0]?.id
                ?? null;
            setSelectedPhoto(
                selectedPhotoId && photosById.has(selectedPhotoId) && !missing.has(selectedPhotoId)
                    ? selectedPhotoId
                    : next.clusters[0]?.top_pick_id ?? analysisPhotos[0]?.id ?? null,
            );
            status = missing.size > 0
                ? `Learned from ${missing.size} deleted photo${missing.size === 1 ? "" : "s"} · ${next.stats.indexed}/${next.stats.total} indexed`
                : `${next.stats.indexed}/${next.stats.total} indexed`;
        } catch (error) {
            status = error instanceof Error ? error.message : String(error);
        } finally {
            if (runId === analysisRun) isAnalyzing = false;
        }
    }

    function loadPreferenceProfileState() {
        const folderPath = HologramAPI.getActiveFolderPath();
        if (folderPath === preferenceProfileFolderPath && preferenceProfiles.length > 0) return;
        preferenceProfileFolderPath = folderPath;
        preferenceProfiles = loadPreferenceProfiles(folderPath);
        activePreferenceProfileId = loadActivePreferenceProfileId(folderPath);
        loadConfirmedSignatures(folderPath);
    }

    function setPreferenceProfile(profileId: string) {
        if (!preferenceProfiles.some((profile) => profile.id === profileId)) return;
        activePreferenceProfileId = profileId;
        saveActivePreferenceProfileId(HologramAPI.getActiveFolderPath(), profileId);
        status = "Profile changed";
    }

    function createProfile() {
        const name = window.prompt("Preference profile name");
        if (!name?.trim()) return;
        const folderPath = HologramAPI.getActiveFolderPath();
        const profile = createPreferenceProfile(folderPath, name);
        preferenceProfiles = loadPreferenceProfiles(folderPath);
        setPreferenceProfile(profile.id);
    }

    function selectCluster(cluster: AutoCullCluster) {
        activeClusterId = cluster.id;
        setSelectedPhoto(cluster.top_pick_id, true);
    }

    function selectPhoto(photoId: string, reveal = false) {
        setSelectedPhoto(photoId, reveal);
        const cluster = session?.clusters.find((item) => item.photo_ids.includes(photoId));
        activeClusterId = cluster?.id ?? activeClusterId;
    }

    function setReviewMode(next: "bursts" | "all") {
        reviewMode = next;
        if (next === "bursts" && activeCluster) {
            setSelectedPhoto(activeCluster.top_pick_id, true);
        } else if (next === "all" && !selectedPhotoId) {
            setSelectedPhoto(rankedRecommendations[0]?.photo_id ?? photos[0]?.id ?? null, true);
        } else if (selectedPhotoId) {
            revealSelectedPhoto(selectedPhotoId);
        }
    }

    function relatedIds(photo: Photo): string[] {
        return [photo.id, photo.paired_with].filter(Boolean) as string[];
    }

    function setFlag(photo: Photo, flag: CullFlag) {
        for (const id of relatedIds(photo)) {
            const relatedPhoto = allPhotosById.get(id) ?? photosById.get(id) ?? photo;
            recordPreferenceRefinement(
                HologramAPI.getActiveFolderPath(),
                activePreferenceProfileId,
                id,
                flag,
                relatedPhoto.rating ?? 0,
            );
            photoStore.setPhotoFlag(id, flag);
        }
    }

    function setRating(photo: Photo, rating: number) {
        for (const id of relatedIds(photo)) {
            const relatedPhoto = allPhotosById.get(id) ?? photosById.get(id) ?? photo;
            recordPreferenceRefinement(
                HologramAPI.getActiveFolderPath(),
                activePreferenceProfileId,
                id,
                relatedPhoto.flag ?? "none",
                rating,
            );
            photoStore.setPhotoRating(id, rating);
        }
    }

    function markSelected(flag: CullFlag, advance = false) {
        if (!selectedPhoto) return;
        setFlag(selectedPhoto, flag);
        if (advance) moveSelection(1);
    }

    function rateSelected(rating: number, advance = false) {
        if (!selectedPhoto) return;
        setRating(selectedPhoto, rating);
        if (advance) moveSelection(1);
    }

    function clearSelectedCull() {
        if (!selectedPhoto) return;
        setFlag(selectedPhoto, "none");
        setRating(selectedPhoto, 0);
    }

    function visibleClusterPhotoIds(cluster: AutoCullCluster): string[] {
        return cluster.photo_ids.filter((id) => photosById.has(id));
    }

    function rankedPhotoIds(): string[] {
        const ids = rankedRecommendations.length > 0
            ? rankedRecommendations.map((item) => item.photo_id)
            : photos.map((photo) => photo.id);
        return ids.filter((id) => photosById.has(id));
    }

    function clampIndex(index: number, length: number): number {
        return Math.max(0, Math.min(length - 1, index));
    }

    function moveSelection(delta: number) {
        if (photos.length === 0) return;

        if (reviewMode === "bursts" && clusterList.length > 0) {
            const currentCluster = activeCluster ?? clusterList[0];
            const currentClusterIndex = Math.max(0, clusterList.findIndex((cluster) => cluster.id === currentCluster.id));
            const currentIds = visibleClusterPhotoIds(currentCluster);
            const currentPhotoIndex = selectedPhotoId ? currentIds.indexOf(selectedPhotoId) : -1;
            const nextPhotoIndex = currentPhotoIndex === -1
                ? (delta > 0 ? 0 : currentIds.length - 1)
                : currentPhotoIndex + delta;

            if (nextPhotoIndex >= 0 && nextPhotoIndex < currentIds.length) {
                selectPhoto(currentIds[nextPhotoIndex], true);
                return;
            }

            const nextClusterIndex = clampIndex(currentClusterIndex + (delta > 0 ? 1 : -1), clusterList.length);
            if (nextClusterIndex === currentClusterIndex) return;

            const nextCluster = clusterList[nextClusterIndex];
            const nextIds = visibleClusterPhotoIds(nextCluster);
            const nextTopPickId = photosById.has(nextCluster.top_pick_id)
                ? nextCluster.top_pick_id
                : nextIds[0] ?? nextCluster.top_pick_id;
            activeClusterId = nextCluster.id;
            setSelectedPhoto(
                delta > 0
                    ? nextTopPickId
                    : nextIds[nextIds.length - 1] ?? nextCluster.top_pick_id,
                true,
            );
            return;
        }

        const ids = rankedPhotoIds();
        if (ids.length === 0) return;
        const currentIndex = selectedPhotoId ? ids.indexOf(selectedPhotoId) : -1;
        const nextIndex = currentIndex === -1
            ? (delta > 0 ? 0 : ids.length - 1)
            : clampIndex(currentIndex + delta, ids.length);
        selectPhoto(ids[nextIndex], true);
    }

    function isTypingTarget(target: EventTarget | null): boolean {
        const element = target as HTMLElement | null;
        return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;

        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            moveSelection(1);
            return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            moveSelection(-1);
            return;
        }
        if (/^[0-5]$/.test(event.key)) {
            event.preventDefault();
            const rating = Number(event.key);
            rateSelected(rating, rating > 0);
            return;
        }
        if (event.key === "p" || event.key === "P") {
            event.preventDefault();
            markSelected("pick", true);
            return;
        }
        if (event.key === "x" || event.key === "X") {
            event.preventDefault();
            markSelected("reject", true);
            return;
        }
        if (event.key === "u" || event.key === "U") {
            event.preventDefault();
            clearSelectedCull();
        }
    }

    function clusterFlag(id: string): CullFlag {
        return normalizedFlag(allPhotosById.get(id) ?? photosById.get(id));
    }

    // Shortcut: keep the AI's recommended frame as one of the cluster's keepers.
    function acceptAiPick(cluster: AutoCullCluster | null = activeCluster) {
        if (!cluster) return;
        const winner = allPhotosById.get(cluster.top_pick_id) ?? photosById.get(cluster.top_pick_id);
        if (!winner) return;
        setFlag(winner, "pick");
        setRating(winner, Math.max(5, winner.rating ?? 0));
        setSelectedPhoto(winner.id);
        status = "AI pick kept";
    }

    // Confirm the cluster: train the taste model that every keeper (pick) beats every
    // discarded frame — supports multiple keepers — then advance to the next cluster.
    function confirmCluster(cluster: AutoCullCluster | null = activeCluster) {
        if (!cluster) return;
        const winners = cluster.photo_ids.filter((id) => clusterFlag(id) === "pick");
        const losers = cluster.photo_ids.filter((id) => clusterFlag(id) !== "pick");
        if (winners.length > 0 && losers.length > 0) {
            const preferences: AutoCullPairwisePreference[] = [];
            for (const winnerId of winners) {
                for (const loserId of losers) {
                    preferences.push({
                        winner_photo_id: winnerId,
                        loser_photo_id: loserId,
                        confidence: 1,
                        source: "cluster_winner",
                        created_at: new Date().toISOString(),
                    });
                }
            }
            addPairwisePreferences(HologramAPI.getActiveFolderPath(), preferences, activePreferenceProfileId);
            confirmedSignatures = new Set([...confirmedSignatures, clusterSignature(cluster)]);
            persistConfirmedSignatures();
        }
        status = winners.length
            ? `Trained on ${winners.length} keeper${winners.length > 1 ? "s" : ""}`
            : "No keepers picked yet";
        stepCluster(1);
    }

    function applyRejectSuggestions() {
        for (const item of rejectCandidates) {
            const photo = allPhotosById.get(item.photo_id) ?? photosById.get(item.photo_id);
            if (photo) setFlag(photo, "reject");
        }
        status = `${rejectCandidates.length} rejects applied`;
    }

    function normalizedFlag(photo: Photo | null | undefined): CullFlag {
        return photo?.flag === "pick" || photo?.flag === "reject" ? photo.flag : "none";
    }

    function scoreWidth(score: number): string {
        return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
    }

    function percent(score: number): string {
        return `${Math.round(score * 100)}%`;
    }

    function formatScore(score: number | undefined): string {
        return score == null ? "--" : score.toFixed(2);
    }

    function clusterTitle(cluster: AutoCullCluster): string {
        if (cluster.kind === "burst") return "Burst";
        if (cluster.kind === "similar") return "Similar";
        return "Single";
    }

    function clusterKindRank(kind: AutoCullCluster["kind"]): number {
        if (kind === "burst") return 0;
        if (kind === "similar") return 1;
        return 2;
    }

    // 3a badge for a burst frame, from the model recommendation.
    function frameBadge(label: AutoCullLabel | undefined): { text: string; cls: string } {
        switch (label) {
            case "SELECT":
                return { text: "TOP PICK", cls: "bg-pick text-black" };
            case "MAYBE":
                return { text: "MAYBE", cls: "border border-maybe/50 bg-maybe/10 text-maybe" };
            case "NEEDS_REVIEW":
                return { text: "NEEDS REVIEW", cls: "border border-info/50 bg-info/10 text-info" };
            case "REJECT":
                return { text: "REJECT", cls: "border border-reject/50 bg-reject/10 text-reject" };
            default:
                return { text: "UNRATED", cls: "bg-secondary text-muted-foreground" };
        }
    }

    // Frames shown in the main area: cluster members in bursts mode, worst-first in all mode.
    const mainFrames = $derived<{ photo: Photo; rec: AutoCullPhoto | null }[]>(
        reviewMode === "bursts"
            ? clusterPhotos.map((photo) => ({ photo, rec: recommendationsById.get(photo.id) ?? null }))
            : rankedRecommendations
                  .map((item) => ({ photo: photosById.get(item.photo_id), rec: item }))
                  .filter((frame): frame is { photo: Photo; rec: AutoCullPhoto } => Boolean(frame.photo)),
    );

    function scorePct10(score: number | undefined): string {
        return score == null ? "--" : (Math.max(0, Math.min(1, score)) * 10).toFixed(1);
    }

    const activeProfileName = $derived(
        preferenceProfiles.find((profile) => profile.id === activePreferenceProfileId)?.name ?? "Personal",
    );

    function formatClusterTime(iso: string | undefined): string {
        if (!iso) return "";
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
            ? ""
            : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function openInLoupe(photoId: string) {
        setSelectedPhoto(photoId);
        const cluster = activeCluster;
        const previewIds = cluster
            ? visibleClusterPhotoIds(cluster)
            : [photoId];
        const followingIds = cluster
            ? clusterList
                  .slice(activeClusterIndex + 1)
                  .flatMap(visibleClusterPhotoIds)
                  .filter((id) => !previewIds.includes(id))
                  .slice(0, Math.max(0, 8 - previewIds.length))
            : [];
        onOpenPreview(previewIds, photoId, cluster ? () => confirmCluster(cluster) : undefined, followingIds);
    }

    const activeClusterIndex = $derived(
        Math.max(0, clusterList.findIndex((cluster) => cluster.id === activeCluster?.id)),
    );

    function stepCluster(delta: number) {
        if (clusterList.length === 0) return;
        const next = clusterList[Math.max(0, Math.min(clusterList.length - 1, activeClusterIndex + delta))];
        if (next) selectCluster(next);
    }

    // A cluster is "kept" once you've chosen a keeper (a manual pick) within it,
    // and "confirmed" once you've hit Confirm to train the model on it.
    function clusterHasPick(cluster: AutoCullCluster): boolean {
        return cluster.photo_ids.some((id) => photosById.get(id)?.flag === "pick");
    }

    // "Confirmed" is keyed on the cluster's photo set (sorted ids), not the volatile
    // cluster id, so the marker survives re-analysis and is persisted per folder.
    function clusterSignature(cluster: AutoCullCluster): string {
        return [...cluster.photo_ids].sort().join("|");
    }

    function confirmedStorageKey(folderPath: string | null | undefined): string {
        return `hologram.autocull.confirmed:${folderPath ?? "none"}`;
    }

    let confirmedSignatures = $state<Set<string>>(new Set());

    function loadConfirmedSignatures(folderPath: string | null | undefined) {
        try {
            const raw = localStorage.getItem(confirmedStorageKey(folderPath));
            confirmedSignatures = new Set(raw ? (JSON.parse(raw) as string[]) : []);
        } catch {
            confirmedSignatures = new Set();
        }
    }

    function persistConfirmedSignatures() {
        try {
            localStorage.setItem(
                confirmedStorageKey(HologramAPI.getActiveFolderPath()),
                JSON.stringify([...confirmedSignatures]),
            );
        } catch {
            /* storage unavailable — keep the in-memory set */
        }
    }

    const resolvedClusterCount = $derived(clusterList.filter(clusterHasPick).length);
    const confirmedClusterCount = $derived(
        clusterList.filter((cluster) => confirmedSignatures.has(clusterSignature(cluster))).length,
    );
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet deckLabel(text: string)}
    <div class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">{text}</div>
{/snippet}

<section class="flex h-full min-h-0 bg-background" data-autocull-view>
    <!-- DECK: analysis / threshold / taste -->
    <aside class="flex w-[248px] shrink-0 flex-col gap-[18px] overflow-y-auto border-r border-border bg-card p-[16px_14px]">
        <!-- ANALYSIS -->
        <section>
            {@render deckLabel("AutoCull")}
            {#if isAnalyzing}
                <div class="text-[13px] font-semibold text-foreground">Analyzing…</div>
                <div class="mt-1 font-mono text-[11px] text-info">{progress.current}/{progress.total} indexed</div>
                <div class="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
                    <div class="h-full rounded-full bg-info" style:width={progress.total ? scoreWidth(progress.current / progress.total) : "8%"}></div>
                </div>
            {:else if session}
                <div class="text-[13px] font-semibold text-foreground">Analysis complete</div>
                <div class="mt-1 font-mono text-[11px] leading-[1.6] text-muted-foreground">
                    {session.stats.total} photos → {burstCount} clusters<br />
                    {session.stats.indexed}/{session.stats.total} indexed
                    {#if session.embedding_backend}· {selectedRecommendation?.embedding ? session.embedding_backend : "metadata"}{/if}
                </div>
            {:else}
                <div class="text-[13px] font-semibold text-foreground">Not analyzed yet</div>
                <div class="mt-1 font-mono text-[11px] text-muted-foreground">{photos.length} photos ready</div>
            {/if}
            <button
                class="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-[6px] font-sans text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                onclick={runAnalysis}
                disabled={isAnalyzing}
            >
                {#if isAnalyzing}<Loader2 size={13} class="animate-spin" />{:else}<RefreshCw size={13} />{/if}
                Re-run analysis
            </button>
        </section>

        <!-- REJECT THRESHOLD -->
        <section>
            {@render deckLabel("Reject threshold")}
            <div class="mb-1.5 flex items-center justify-between font-mono text-[10px]">
                <span class="text-muted-foreground">score ≤ <span class="text-foreground">{scorePct10(rejectThreshold)}</span></span>
                <span class="text-reject">{rejectCandidates.length} candidates</span>
            </div>
            <input class="grid-zoom-slider mb-2.5 h-3 w-full" type="range" min="0.25" max="0.55" step="0.01" bind:value={rejectThreshold} aria-label="Reject threshold" />
            <button
                class="w-full rounded-md bg-reject py-[7px] text-center font-sans text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                onclick={applyRejectSuggestions}
                disabled={!session || rejectCandidates.length === 0}
            >
                Apply {rejectCandidates.length} bulk rejects
            </button>
            <div class="mt-1.5 font-mono text-[9.5px] leading-[1.5] text-subtle">Your manual flags always take precedence. Reversible until export.</div>
        </section>

        <!-- TASTE PROFILE -->
        <section>
            {@render deckLabel("Taste profile")}
            <div class="flex flex-col gap-[2px]">
                {#each preferenceProfiles as profile (profile.id)}
                    <button
                        class="flex items-center justify-between rounded-[5px] px-2 py-[6px] text-left font-sans text-[12px] font-medium transition-colors {activePreferenceProfileId === profile.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                        onclick={() => setPreferenceProfile(profile.id)}
                    >
                        <span class="truncate">{profile.name}</span>
                        {#if activePreferenceProfileId === profile.id}<span class="font-mono text-[10px] text-pick">active</span>{/if}
                    </button>
                {/each}
                <button class="flex items-center gap-1 px-2 py-[6px] text-left font-sans text-[12px] text-subtle transition-colors hover:text-foreground" onclick={createProfile}>
                    <Plus size={12} /> New profile
                </button>
            </div>
            <p class="mt-2 px-1 font-sans text-[11px] italic leading-[1.5] text-subtle">
                Picks &amp; ratings train this profile.
            </p>
        </section>
    </aside>
    <!-- MAIN -->
    <div class="flex min-w-0 flex-1 flex-col">
        {#if isAnalyzing}
            <div class="h-[2px] shrink-0 bg-secondary"><div class="h-full bg-info transition-[width]" style:width={progress.total ? scoreWidth(progress.current / progress.total) : "8%"}></div></div>
        {/if}

        {#if !session && !isAnalyzing}
            <div class="grid flex-1 place-items-center px-8">
                <button class="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90" onclick={runAnalysis}>
                    <Sparkles size={16} /> Analyze {photos.length} photos
                </button>
            </div>
        {:else}
            <!-- mode + meta -->
            <div class="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3.5">
                <div class="flex overflow-hidden rounded-md border border-border font-sans text-[11px] font-medium">
                    <button class="px-3 py-[6px] transition-colors {reviewMode === 'bursts' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}" onclick={() => setReviewMode("bursts")} disabled={burstCount === 0}>Clusters</button>
                    <button class="px-3 py-[6px] transition-colors {reviewMode === 'all' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}" onclick={() => setReviewMode("all")}>Ranked · worst first</button>
                </div>
                {#if reviewMode === "bursts" && activeCluster}
                    <div class="flex items-center gap-1.5">
                        <button
                            class="grid h-6 w-6 place-items-center rounded border border-border text-subtle transition-colors hover:text-foreground disabled:opacity-30"
                            onclick={() => stepCluster(-1)}
                            disabled={activeClusterIndex === 0}
                            aria-label="Previous cluster"
                        >‹</button>
                        <div class="font-mono text-[11px] text-muted-foreground">
                            cluster <span class="text-foreground">{activeClusterIndex + 1}</span> / {burstCount} · {clusterTitle(activeCluster).toLowerCase()}{#if formatClusterTime(activeCluster.start_time)} · {formatClusterTime(activeCluster.start_time)}{/if}
                        </div>
                        <button
                            class="grid h-6 w-6 place-items-center rounded border border-border text-subtle transition-colors hover:text-foreground disabled:opacity-30"
                            onclick={() => stepCluster(1)}
                            disabled={activeClusterIndex >= clusterList.length - 1}
                            aria-label="Next cluster"
                        >›</button>
                    </div>
                {:else}
                    <div class="font-mono text-[11px] text-muted-foreground">{mainFrames.length} photos · worst first</div>
                {/if}
                <div class="flex-1"></div>
                <div class="flex gap-1.5 font-mono text-[10px] text-subtle">
                    <span class="rounded border border-border px-1.5 py-[3px]">↵ accept</span>
                    <span class="rounded border border-border px-1.5 py-[3px]">dbl-click preview</span>
                    <span class="rounded border border-border px-1.5 py-[3px]">⇥ next</span>
                </div>
            </div>

            <!-- frame grid -->
            <div class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
                <div class="flex flex-wrap gap-2">
                    {#each mainFrames as frame (frame.photo.id)}
                        {@const rec = frame.rec}
                        {@const badge = frameBadge(rec?.recommendation)}
                        {@const flag = normalizedFlag(frame.photo)}
                        <button
                            class="group relative h-[194px] w-[290px] shrink-0 overflow-hidden rounded-[5px] border transition-all {selectedPhotoId === frame.photo.id ? 'border-primary shadow-[0_0_0_4px_rgba(92,232,164,.15)]' : 'border-border hover:border-ring'} {flag === 'reject' ? 'opacity-50' : ''}"
                            data-autocull-photo-id={frame.photo.id}
                            onclick={() => selectPhoto(frame.photo.id)}
                            ondblclick={() => openInLoupe(frame.photo.id)}
                            title="{frame.photo.file_name} — double-click to preview"
                        >
                            <PhotoPreviewCard photo={frame.photo} detailMode="image" fit="cover" iconSize={22} previewQuality="display" showControls={false} containerClass="h-full w-full aspect-auto" />
                            <span class="absolute left-2 top-2 rounded px-[7px] py-[2px] font-mono text-[9px] font-bold {badge.cls}">{badge.text}{#if rec && badge.text === "TOP PICK"} · {percent(rec.final_score)}{/if}</span>
                            {#if flag === "pick"}<span class="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-pick text-[10px] font-bold text-black" title="manual pick overrides">✓</span>{/if}
                            <span class="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
                                <span class="flex items-center gap-1 rounded-md bg-black/65 px-2 py-1 font-mono text-[10px] text-white"><Maximize2 size={12} /> preview</span>
                            </span>
                            <span class="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent px-2 pb-[5px] pt-3.5 font-mono text-[10px] text-white">
                                <span class="truncate">{frame.photo.file_name}</span>
                                <span class="{flag === 'none' && rec?.recommendation === 'SELECT' ? 'text-pick' : 'text-white/85'}">{scorePct10(rec?.final_score)}</span>
                            </span>
                        </button>
                    {/each}
                    {#if mainFrames.length === 0}
                        <div class="rounded-md border border-dashed border-border px-4 py-6 font-mono text-[11px] text-muted-foreground">No frames in this view.</div>
                    {/if}
                </div>

                {#if reviewMode === "bursts" && clusterList.length > 1}
                    <div class="mt-auto">
                        {@render deckLabel(`Clusters · ${resolvedClusterCount} kept · ${confirmedClusterCount} trained`)}
                        <div class="flex gap-1.5 overflow-x-auto pb-1">
                            {#each clusterList as cluster, index (cluster.id)}
                                {@const top = photosById.get(cluster.top_pick_id)}
                                {@const isActive = cluster.id === activeCluster?.id}
                                {@const kept = clusterHasPick(cluster)}
                                {@const confirmed = confirmedSignatures.has(clusterSignature(cluster))}
                                <button
                                    class="relative h-[62px] w-[92px] shrink-0 overflow-hidden rounded-[3px] border transition-all {isActive ? 'border-transparent opacity-100 outline outline-2 -outline-offset-2 outline-primary' : kept ? 'border-border opacity-35 hover:opacity-70' : 'border-border opacity-80 hover:opacity-100'}"
                                    onclick={() => selectCluster(cluster)}
                                    title={`Cluster ${index + 1} · ${clusterTitle(cluster)} · ${cluster.photo_ids.length} frames${confirmed ? " · trained" : kept ? " · kept, not confirmed" : ""}`}
                                >
                                    {#if top}<PhotoPreviewCard photo={top} detailMode="image" fit="cover" iconSize={14} showControls={false} containerClass="h-full w-full aspect-auto" />{/if}
                                    <span class="absolute left-1 top-1 rounded bg-black/60 px-1 font-mono text-[8px] text-white/90">{index + 1}</span>
                                    {#if confirmed}
                                        <span class="absolute right-1 top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-pick text-black" title="trained — keepers fed the model"><Check size={9} /></span>
                                    {:else if kept}
                                        <span class="absolute right-1 top-1 grid h-3.5 w-3.5 place-items-center rounded-full border border-white/50 bg-black/50 text-white/80" title="kept · not confirmed"><Check size={9} /></span>
                                    {:else}
                                        <span class="absolute bottom-0.5 right-1 font-mono text-[8px] text-white/80">{cluster.photo_ids.length}</span>
                                    {/if}
                                </button>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>
        {/if}
    </div>

    <!-- SCORE CARD -->
    {#if session && selectedPhoto}
        {@const rec = selectedRecommendation}
        <aside class="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
            <div>
                {@render deckLabel(`Score — ${selectedPhoto.file_name}`)}
                {#if rec}
                    {@const badge = frameBadge(rec.recommendation)}
                    <div class="flex items-center gap-2.5">
                        <span class="rounded px-[9px] py-1 font-mono text-[11px] font-bold {badge.cls}">{rec.recommendation?.replace("_", " ") ?? "—"}</span>
                        <span class="font-mono text-[11px] text-muted-foreground">confidence {percent(rec.confidence)}</span>
                    </div>
                {/if}
            </div>
            {#if rec}
                <div class="flex items-baseline gap-2">
                    <span class="font-mono text-[34px] font-bold leading-none text-foreground">{scorePct10(rec.final_score)}</span>
                    <span class="font-mono text-[11px] text-subtle">final / 10</span>
                </div>
                <div class="flex flex-col gap-2.5">
                    <div>
                        <div class="mb-1 flex justify-between font-mono text-[10.5px] text-muted-foreground"><span>TECHNICAL</span><span class="text-foreground">{scorePct10(rec.technical_score)}</span></div>
                        <div class="h-1 rounded-full bg-secondary"><div class="h-1 rounded-full bg-info" style:width={scoreWidth(rec.technical_score)}></div></div>
                    </div>
                    <div>
                        <div class="mb-1 flex justify-between font-mono text-[10.5px] text-muted-foreground"><span>PERSONAL — {activeProfileName}</span><span class="text-foreground">{scorePct10(rec.personal_score)}</span></div>
                        <div class="h-1 rounded-full bg-secondary"><div class="h-1 rounded-full bg-pick" style:width={scoreWidth(rec.personal_score)}></div></div>
                    </div>
                </div>
                <div class="flex flex-col gap-[7px] border-t border-border pt-3 font-mono text-[10.5px] text-muted-foreground">
                    <div class="flex justify-between"><span>final</span><span class="text-foreground">{formatScore(rec.final_score)}</span></div>
                    <div class="flex justify-between"><span>technical</span><span class="text-foreground">{formatScore(rec.technical_score)}</span></div>
                    <div class="flex justify-between"><span>personal</span><span class="text-foreground">{formatScore(rec.personal_score)}</span></div>
                    <div class="flex justify-between"><span>confidence</span><span class="text-foreground">{percent(rec.confidence)}</span></div>
                    <div class="flex justify-between"><span>taste signal</span><span class="text-foreground">{rec.behavior_signal >= 0 ? "+" : ""}{formatScore(rec.behavior_signal)}</span></div>
                    <div class="flex justify-between"><span>source</span><span class="text-foreground">{rec.embedding ? (session.embedding_backend ?? "embedding") : "metadata"}</span></div>
                    {#if activeCluster}
                        <div class="flex justify-between"><span>cluster size</span><span class="text-foreground">{activeCluster.photo_ids.length}</span></div>
                        <div class="flex justify-between"><span>similar to picks</span><span class="{activeCluster.confidence >= 0.85 ? 'text-pick' : 'text-foreground'}">{activeCluster.confidence >= 0.85 ? "high" : activeCluster.confidence >= 0.7 ? "medium" : "low"}</span></div>
                    {/if}
                </div>
            {/if}

            <div class="grid grid-cols-3 gap-2">
                <button class="inline-flex h-9 items-center justify-center gap-1 rounded-md px-2 text-xs font-bold transition-opacity hover:opacity-90 {normalizedFlag(selectedPhoto) === 'pick' ? 'bg-pick text-black' : 'bg-pick/20 text-pick'}" onclick={() => markSelected("pick")} aria-keyshortcuts="P" title="Keep this frame — you can keep several from one burst"><Check size={14} />Keep</button>
                <button class="inline-flex h-9 items-center justify-center gap-1 rounded-md bg-secondary px-2 text-xs font-bold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onclick={clearSelectedCull} aria-keyshortcuts="U"><Circle size={14} />Clear</button>
                <button class="inline-flex h-9 items-center justify-center gap-1 rounded-md px-2 text-xs font-bold transition-opacity hover:opacity-90 {normalizedFlag(selectedPhoto) === 'reject' ? 'bg-reject text-white' : 'bg-reject/20 text-reject'}" onclick={() => markSelected("reject")} aria-keyshortcuts="X"><XCircle size={14} />Reject</button>
            </div>
            <div class="flex items-center gap-1">
                {#each [1, 2, 3, 4, 5] as rating}
                    <button class="flex h-8 flex-1 items-center justify-center rounded-md transition-colors {(selectedPhoto.rating ?? 0) >= rating ? 'bg-rating text-black' : 'bg-secondary text-muted-foreground hover:bg-accent hover:text-rating'}" onclick={() => rateSelected((selectedPhoto.rating ?? 0) === rating ? 0 : rating)} aria-keyshortcuts={`${rating}`} title={`${rating} stars`}>
                        <Star size={13} fill="currentColor" />
                    </button>
                {/each}
            </div>
            {#if reviewMode === "bursts" && activeCluster && activeCluster.photo_ids.length > 1}
                {@const clusterPickCount = activeCluster.photo_ids.filter((id) => clusterFlag(id) === "pick").length}
                <div class="rounded-md border border-border p-2.5">
                    <div class="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">
                        <span>This burst</span>
                        <span class={clusterPickCount > 0 ? "text-pick" : ""}>{clusterPickCount} keeper{clusterPickCount === 1 ? "" : "s"}</span>
                    </div>
                    <p class="mb-2 text-[11px] leading-[1.45] text-muted-foreground">
                        <span class="text-foreground">Keep</span> marks a frame as a keeper — pick several if the scene has more than one good shot.
                    </p>
                    <div class="flex flex-col gap-1.5">
                        <button
                            class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            onclick={() => acceptAiPick()}
                            title="Keep the AI's recommended frame (the ✦ top pick) without hunting for it"
                        ><Sparkles size={13} />Accept AI pick</button>
                        <button
                            class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90"
                            onclick={() => confirmCluster()}
                            title="Teach your taste profile that this burst's keepers beat the frames you didn't keep, then jump to the next burst"
                        >Confirm &amp; next cluster →</button>
                    </div>
                </div>
            {/if}
            <div class="mt-auto font-mono text-[9.5px] leading-[1.5] text-subtle">Scores are advisory. Nothing is flagged until you keep, reject, or apply bulk rejects.</div>
        </aside>
    {/if}
</section>
