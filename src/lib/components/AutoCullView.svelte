<script lang="ts">
    import {
        AlertTriangle,
        Check,
        Circle,
        Gauge,
        ImageOff,
        Loader2,
        RefreshCw,
        Rows3,
        Sparkles,
        Star,
        Trophy,
        XCircle,
    } from "@lucide/svelte";
    import {
        addPairwisePreferences,
        buildAutoCullSession,
        loadPairwisePreferences,
        photoPreviewSrc,
    } from "../autocull.ts";
    import { HologramAPI } from "../api.ts";
    import { photoStore } from "../stores/photoStore.ts";
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
    }

    let { photos, allPhotos }: Props = $props();

    let session = $state<AutoCullSession | null>(null);
    let progress = $state<VisualIndexProgress>({ current: 0, total: 0 });
    let isAnalyzing = $state(false);
    let selectedPhotoId = $state<string | null>(null);
    let activeClusterId = $state<string | null>(null);
    let lastAnalysisKey = $state("");
    let status = $state("Ready");
    let rejectThreshold = $state(0.42);
    let analysisRun = 0;

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

    $effect(() => {
        const firstId = photos[0]?.id ?? null;
        if (!selectedPhotoId || !photosById.has(selectedPhotoId)) {
            selectedPhotoId = firstId;
        }
    });

    $effect(() => {
        const key = photos
            .map((photo) => `${photo.id}:${photo.thumbnail ? "t" : "n"}:${photo.rating ?? 0}:${photo.flag ?? "none"}:${photo.tags?.join(",") ?? ""}`)
            .join("|");
        if (!key || key === lastAnalysisKey) return;
        lastAnalysisKey = key;
        void runAnalysis();
    });

    async function runAnalysis() {
        if (photos.length === 0) return;
        const runId = ++analysisRun;
        isAnalyzing = true;
        status = "Analyzing";
        progress = { current: 0, total: photos.length };
        try {
            const folderPath = HologramAPI.getActiveFolderPath();
            const preferences = loadPairwisePreferences(folderPath);
            const next = await buildAutoCullSession(photos, preferences, (nextProgress) => {
                if (runId === analysisRun) progress = nextProgress;
            });
            if (runId !== analysisRun) return;
            session = next;
            activeClusterId = next.clusters.find((cluster) => cluster.photo_ids.includes(selectedPhotoId ?? ""))?.id
                ?? next.clusters[0]?.id
                ?? null;
            selectedPhotoId = selectedPhotoId && photosById.has(selectedPhotoId)
                ? selectedPhotoId
                : next.clusters[0]?.top_pick_id ?? photos[0]?.id ?? null;
            status = `${next.stats.indexed}/${next.stats.total} indexed`;
        } catch (error) {
            status = error instanceof Error ? error.message : String(error);
        } finally {
            if (runId === analysisRun) isAnalyzing = false;
        }
    }

    function selectCluster(cluster: AutoCullCluster) {
        activeClusterId = cluster.id;
        selectedPhotoId = cluster.top_pick_id;
    }

    function selectPhoto(photoId: string) {
        selectedPhotoId = photoId;
        const cluster = session?.clusters.find((item) => item.photo_ids.includes(photoId));
        activeClusterId = cluster?.id ?? activeClusterId;
    }

    function relatedIds(photo: Photo): string[] {
        return [photo.id, photo.paired_with].filter(Boolean) as string[];
    }

    function setFlag(photo: Photo, flag: CullFlag) {
        for (const id of relatedIds(photo)) {
            photoStore.setPhotoFlag(id, flag);
        }
    }

    function setRating(photo: Photo, rating: number) {
        for (const id of relatedIds(photo)) {
            photoStore.setPhotoRating(id, rating);
        }
    }

    function markSelected(flag: CullFlag) {
        if (!selectedPhoto) return;
        setFlag(selectedPhoto, flag);
    }

    function rateSelected(rating: number) {
        if (!selectedPhoto) return;
        setRating(selectedPhoto, rating);
    }

    function acceptClusterWinner(cluster: AutoCullCluster | null = activeCluster) {
        if (!cluster) return;
        const winner = allPhotosById.get(cluster.top_pick_id) ?? photosById.get(cluster.top_pick_id);
        if (!winner) return;

        const preferences: AutoCullPairwisePreference[] = cluster.photo_ids
            .filter((id) => id !== cluster.top_pick_id)
            .map((loserId) => ({
                winner_photo_id: cluster.top_pick_id,
                loser_photo_id: loserId,
                confidence: 1,
                source: "cluster_winner",
                created_at: new Date().toISOString(),
            }));
        addPairwisePreferences(HologramAPI.getActiveFolderPath(), preferences);
        setFlag(winner, "pick");
        setRating(winner, Math.max(5, winner.rating ?? 0));
        status = "Winner saved";
        void runAnalysis();
    }

    function applyRejectSuggestions() {
        for (const item of rejectCandidates) {
            const photo = allPhotosById.get(item.photo_id) ?? photosById.get(item.photo_id);
            if (photo) setFlag(photo, "reject");
        }
        status = `${rejectCandidates.length} rejects applied`;
    }

    function labelClass(label: AutoCullLabel): string {
        if (label === "SELECT") return "bg-pick text-black";
        if (label === "REJECT") return "bg-reject text-white";
        if (label === "NEEDS_REVIEW") return "bg-rating text-black";
        return "bg-primary text-primary-foreground";
    }

    function labelIcon(label: AutoCullLabel) {
        if (label === "SELECT") return Check;
        if (label === "REJECT") return XCircle;
        if (label === "NEEDS_REVIEW") return AlertTriangle;
        return Circle;
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

    function exposureSummary(photo: Photo): string {
        return [
            photo.exif.aperture ? `f/${photo.exif.aperture.toFixed(photo.exif.aperture % 1 === 0 ? 0 : 1)}` : "",
            photo.exif.shutter_speed,
            photo.exif.iso ? `ISO ${photo.exif.iso}` : "",
        ].filter(Boolean).join("  ");
    }

    function recommendationPhoto(item: AutoCullPhoto): Photo | undefined {
        return photosById.get(item.photo_id);
    }
</script>

<section class="flex h-full min-h-0 flex-col bg-background" data-autocull-view>
    <div class="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card/70 px-5">
        <div class="min-w-0">
            <div class="flex items-center gap-2 text-[10px] font-bold uppercase text-primary">
                <Sparkles size={13} />
                AutoCull
            </div>
            <h2 class="truncate text-sm font-semibold text-foreground">{status}</h2>
        </div>

        {#if session}
            <div class="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
                <span class="rounded-md bg-secondary px-2 py-1 tabular-nums">{session.stats.select} select</span>
                <span class="rounded-md bg-secondary px-2 py-1 tabular-nums">{session.stats.maybe} maybe</span>
                <span class="rounded-md bg-secondary px-2 py-1 tabular-nums">{session.stats.needs_review} review</span>
                <span class="rounded-md bg-secondary px-2 py-1 tabular-nums">{session.stats.reject} reject</span>
            </div>
        {/if}

        <div class="ml-auto flex items-center gap-2">
            <label class="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
                Reject
                <input
                    class="h-7 w-28 accent-primary"
                    type="range"
                    min="0.25"
                    max="0.55"
                    step="0.01"
                    bind:value={rejectThreshold}
                    title="Reject threshold"
                />
                <span class="w-9 tabular-nums">{percent(rejectThreshold)}</span>
            </label>
            <button
                class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-secondary px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                onclick={runAnalysis}
                disabled={isAnalyzing}
            >
                {#if isAnalyzing}
                    <Loader2 size={14} class="animate-spin" />
                {:else}
                    <RefreshCw size={14} />
                {/if}
                Analyze
            </button>
            <button
                class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-reject px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                onclick={applyRejectSuggestions}
                disabled={!session || rejectCandidates.length === 0}
            >
                <XCircle size={14} />
                Apply {rejectCandidates.length}
            </button>
        </div>
    </div>

    {#if isAnalyzing}
        <div class="h-1 shrink-0 bg-secondary">
            <div
                class="h-full bg-primary transition-[width]"
                style:width={progress.total ? scoreWidth(progress.current / progress.total) : "8%"}
            ></div>
        </div>
    {/if}

    {#if !session && !isAnalyzing}
        <div class="grid flex-1 place-items-center px-8">
            <button
                class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                onclick={runAnalysis}
            >
                <Sparkles size={16} />
                Analyze Photos
            </button>
        </div>
    {:else}
        <div class="grid min-h-0 flex-1 grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)_minmax(18rem,23rem)]">
            <aside class="min-h-0 overflow-y-auto border-r border-border bg-sidebar/50 p-3">
                <div class="mb-2 flex items-center gap-2 px-1 text-xs font-bold uppercase text-foreground">
                    <Rows3 size={13} class="text-primary" />
                    Clusters
                    <span class="ml-auto text-muted-foreground">{clusterList.length}</span>
                </div>
                <div class="space-y-1">
                    {#each clusterList as cluster (cluster.id)}
                        {@const topPhoto = photosById.get(cluster.top_pick_id)}
                        {@const topRecommendation = recommendationsById.get(cluster.top_pick_id)}
                        <button
                            class="w-full rounded-md px-2 py-2 text-left transition-colors {activeCluster?.id === cluster.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
                            onclick={() => selectCluster(cluster)}
                        >
                            <span class="flex items-center gap-2">
                                <span class="truncate text-xs font-semibold">{clusterTitle(cluster)}</span>
                                <span class="ml-auto rounded bg-black/20 px-1.5 py-0.5 text-[10px] tabular-nums">{cluster.photo_ids.length}</span>
                            </span>
                            <span class="mt-1 block truncate text-[11px] opacity-75">
                                {topPhoto?.file_name ?? "Missing photo"} / {formatScore(topRecommendation?.final_score)}
                            </span>
                        </button>
                    {/each}
                </div>
            </aside>

            <main class="flex min-w-0 flex-col">
                <div class="grid min-h-0 flex-1 place-items-center bg-black">
                    {#if selectedPhoto}
                        {@const src = photoPreviewSrc(selectedPhoto)}
                        <div class="flex h-full w-full flex-col">
                            <div class="grid min-h-0 flex-1 place-items-center p-4">
                                {#if src}
                                    <img
                                        src={src}
                                        alt={selectedPhoto.file_name}
                                        class="h-full w-full object-contain"
                                    />
                                {:else}
                                    <div class="flex flex-col items-center gap-2 text-muted-foreground">
                                        <ImageOff size={42} />
                                        <span class="text-sm">No preview</span>
                                    </div>
                                {/if}
                            </div>
                            <div class="flex h-16 shrink-0 items-center gap-3 border-t border-white/10 bg-black/70 px-4">
                                <div class="min-w-0 flex-1">
                                    <div class="truncate text-sm font-semibold text-white">{selectedPhoto.file_name}</div>
                                    <div class="truncate text-xs text-white/55">
                                        {selectedPhoto.exif.camera_model ?? "Unknown camera"}
                                        {#if exposureSummary(selectedPhoto)}
                                            <span class="text-white/30"> / </span>{exposureSummary(selectedPhoto)}
                                        {/if}
                                    </div>
                                </div>
                                {#if selectedRecommendation}
                                    {@const RecommendationIcon = labelIcon(selectedRecommendation.recommendation)}
                                    <span class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold {labelClass(selectedRecommendation.recommendation)}">
                                        <RecommendationIcon size={13} />
                                        {selectedRecommendation.recommendation.replace("_", " ")}
                                    </span>
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>

                {#if clusterPhotos.length > 1}
                    <div class="flex h-28 shrink-0 gap-2 overflow-x-auto border-t border-border bg-card/70 p-2">
                        {#each clusterPhotos as photo (photo.id)}
                            {@const recommendation = recommendationsById.get(photo.id)}
                            {@const src = photoPreviewSrc(photo)}
                            <button
                                class="relative aspect-[3/2] h-full overflow-hidden rounded-md border bg-black transition-colors {selectedPhotoId === photo.id ? 'border-primary shadow-[0_0_0_2px_var(--color-primary)]' : 'border-border hover:border-ring'}"
                                onclick={() => selectPhoto(photo.id)}
                                title={photo.file_name}
                            >
                                {#if src}
                                    <img src={src} alt={photo.file_name} class="h-full w-full object-cover" />
                                {:else}
                                    <div class="grid h-full w-full place-items-center text-muted-foreground">
                                        <ImageOff size={20} />
                                    </div>
                                {/if}
                                {#if recommendation}
                                    <span class="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
                                        {formatScore(recommendation.final_score)}
                                    </span>
                                {/if}
                            </button>
                        {/each}
                    </div>
                {/if}
            </main>

            <aside class="min-h-0 overflow-y-auto border-l border-border bg-card/50 p-4">
                {#if selectedPhoto && selectedRecommendation}
                    <div class="mb-4 flex items-start gap-3">
                        <div class="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                            <Gauge size={20} />
                        </div>
                        <div class="min-w-0">
                            <h3 class="truncate text-sm font-semibold text-foreground">{selectedPhoto.file_name}</h3>
                            <p class="mt-0.5 text-xs text-muted-foreground">
                                {selectedRecommendation.embedding ? session?.embedding_backend : "metadata fallback"}
                            </p>
                        </div>
                    </div>

                    <div class="space-y-3">
                        <div>
                            <div class="mb-1 flex items-center justify-between text-xs">
                                <span class="font-semibold text-muted-foreground">Final</span>
                                <span class="tabular-nums text-foreground">{formatScore(selectedRecommendation.final_score)}</span>
                            </div>
                            <div class="h-1.5 overflow-hidden rounded-full bg-secondary">
                                <div class="h-full rounded-full bg-primary" style:width={scoreWidth(selectedRecommendation.final_score)}></div>
                            </div>
                        </div>
                        <div>
                            <div class="mb-1 flex items-center justify-between text-xs">
                                <span class="font-semibold text-muted-foreground">Personal</span>
                                <span class="tabular-nums text-foreground">{formatScore(selectedRecommendation.personal_score)}</span>
                            </div>
                            <div class="h-1.5 overflow-hidden rounded-full bg-secondary">
                                <div class="h-full rounded-full bg-pick" style:width={scoreWidth(selectedRecommendation.personal_score)}></div>
                            </div>
                        </div>
                        <div>
                            <div class="mb-1 flex items-center justify-between text-xs">
                                <span class="font-semibold text-muted-foreground">Technical</span>
                                <span class="tabular-nums text-foreground">{formatScore(selectedRecommendation.technical_score)}</span>
                            </div>
                            <div class="h-1.5 overflow-hidden rounded-full bg-secondary">
                                <div class="h-full rounded-full bg-rating" style:width={scoreWidth(selectedRecommendation.technical_score)}></div>
                            </div>
                        </div>
                    </div>

                    <div class="mt-5 grid grid-cols-3 gap-2">
                        <button
                            class="inline-flex h-9 items-center justify-center gap-1 rounded-md bg-pick px-2 text-xs font-bold text-black transition-opacity hover:opacity-90"
                            onclick={() => markSelected("pick")}
                        >
                            <Check size={14} />
                            Pick
                        </button>
                        <button
                            class="inline-flex h-9 items-center justify-center gap-1 rounded-md bg-secondary px-2 text-xs font-bold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            onclick={() => markSelected("none")}
                        >
                            <Circle size={14} />
                            Clear
                        </button>
                        <button
                            class="inline-flex h-9 items-center justify-center gap-1 rounded-md bg-reject px-2 text-xs font-bold text-white transition-opacity hover:opacity-90"
                            onclick={() => markSelected("reject")}
                        >
                            <XCircle size={14} />
                            Reject
                        </button>
                    </div>

                    <div class="mt-3 flex items-center gap-1">
                        {#each [1, 2, 3, 4, 5] as rating}
                            <button
                                class="grid h-8 flex-1 place-items-center rounded-md transition-colors {(selectedPhoto.rating ?? 0) >= rating ? 'bg-rating text-black' : 'bg-secondary text-muted-foreground hover:bg-accent hover:text-rating'}"
                                onclick={() => rateSelected((selectedPhoto.rating ?? 0) === rating ? 0 : rating)}
                                title={`${rating} stars`}
                            >
                                <Star size={14} fill="currentColor" />
                            </button>
                        {/each}
                    </div>

                    {#if activeCluster && activeCluster.photo_ids.length > 1}
                        <button
                            class="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                            onclick={() => acceptClusterWinner(activeCluster)}
                        >
                            <Trophy size={15} />
                            Accept Cluster Winner
                        </button>
                    {/if}
                {/if}

                {#if rankedRecommendations.length > 0}
                    <div class="mt-6">
                        <div class="mb-2 flex items-center gap-2 text-xs font-bold uppercase text-foreground">
                            <AlertTriangle size={13} class="text-rating" />
                            Lowest Ranked
                        </div>
                        <div class="space-y-1">
                            {#each rankedRecommendations.slice(0, 7) as item (item.photo_id)}
                                {@const photo = recommendationPhoto(item)}
                                {#if photo}
                                    <button
                                        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                        onclick={() => selectPhoto(item.photo_id)}
                                    >
                                        <span class="min-w-0 flex-1 truncate">{photo.file_name}</span>
                                        <span class="tabular-nums">{formatScore(item.final_score)}</span>
                                    </button>
                                {/if}
                            {/each}
                        </div>
                    </div>
                {/if}
            </aside>
        </div>
    {/if}
</section>
