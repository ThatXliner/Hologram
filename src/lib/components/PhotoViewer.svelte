<script lang="ts">
    import { convertFileSrc } from "@tauri-apps/api/core";
    import { onDestroy, onMount, tick } from "svelte";
    import { photoStore } from "../stores/photoStore.ts";
    import { HologramAPI } from "../api.ts";
    import type { CullFlag, Photo } from "../types.ts";
    import {
        Aperture,
        Calendar,
        Camera,
        Check,
        ChevronLeft,
        ChevronRight,
        Circle,
        Clock,
        Columns2,
        ExternalLink,
        FileImage,
        Image,
        Loader2,
        Info,
        MapPin,
        Maximize2,
        Monitor,
        SlidersHorizontal,
        Star,
        Trash2,
        Upload,
        X,
        XCircle,
        ZoomIn,
        ZoomOut,
    } from "@lucide/svelte";
    import ImageEditor from "./ImageEditor.svelte";
    import { builtInRawPresets, parseRawPresetFile, presetSummary } from "../presets.ts";
    import type { RawProcessingPreset } from "../types.ts";

    interface Props {
        photos: Photo[];
        allPhotos: Photo[];
        startIndex?: number;
    }

    type LoadedImage = {
        url: string;
        fullRes: boolean;
    };
    type EmbeddedPreview = NonNullable<Photo["embedded_jpeg_preview"]>;
    type CompareCandidate = {
        photo: Photo;
        distance: number;
        index: number;
    };

    let { photos, allPhotos, startIndex = 0 }: Props = $props();

    let currentIndex = $state<number>(startIndex);
    const photo = $derived(photos[currentIndex]);
    const hasPrevious = $derived(currentIndex > 0);
    const hasNext = $derived(currentIndex < photos.length - 1);
    const isPaired = $derived(photo?.paired_with != null);
    const pairedPhoto = $derived(isPaired ? allPhotos.find((item) => item.id === photo.paired_with) : null);
    let viewingRaw = $state(false);
    const activePhoto = $derived(viewingRaw && pairedPhoto ? pairedPhoto : photo);
    const activeEmbeddedPreview = $derived(embeddedPreviewInfo(activePhoto));

    let currentBlobUrl = $state<string | null>(null);
    let currentBlobPhotoId = $state<string | null>(null);
    let fullResCandidatePhotoId = $state<string | null>(null);
    let isLoadingFullRes = $state(false);
    let hasFullRes = $state(false);
    const activeFullResLoaded = $derived(!!activePhoto && hasFullRes && currentBlobPhotoId === activePhoto.id);
    let loadError = $state<string | null>(null);
    let failedPreviewIds = $state<Set<string>>(new Set());
    let failedThumbnailIds = $state<Set<string>>(new Set());
    const failedImageRetryKeys = new Set<string>();
    const preloadCache = new Map<string, LoadedImage>();
    const preloadingSet = new Set<string>();

    let showEditor = $state(false);
    let editedPreviewUrl = $state<string | null>(null);
    let autoAdvance = $state(true);
    let compareMode = $state(false);
    let comparePhotoId = $state<string | null>(null);
    let customPresets = $state<RawProcessingPreset[]>([]);
    let selectedPresetId = $state("builtin-neutral");
    let presetInput: HTMLInputElement | undefined = $state();
    const allPresets = $derived([...builtInRawPresets, ...customPresets]);
    const activePreset = $derived(allPresets.find((preset) => preset.id === selectedPresetId) ?? allPresets[0] ?? null);
    const compareCandidates = $derived(getCompareCandidates());
    const comparePhoto = $derived(
        compareCandidates.find((candidate) => candidate.photo.id === comparePhotoId)?.photo ??
            compareCandidates[0]?.photo ??
            null,
    );

    let imageViewport = $state<HTMLDivElement | null>(null);
    let viewportWidth = $state(0);
    let viewportHeight = $state(0);
    let loadedImagePhotoId = $state<string | null>(null);
    let loadedImageUrl = $state<string | null>(null);
    let loadedImageWidth = $state(0);
    let loadedImageHeight = $state(0);
    let zoomLevel = $state(1);
    let panX = $state(0);
    let panY = $state(0);
    let isPanning = $state(false);
    let panStartX = 0;
    let panStartY = 0;
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 12];
    const zoomPercent = $derived(Math.round(zoomLevel * 100));

    let tagInput = $state("");
    let notesValue = $state("");
    const filmstripStart = $derived(Math.max(0, currentIndex - 5));
    const filmstripPhotos = $derived(photos.slice(filmstripStart, Math.min(photos.length, currentIndex + 6)));

    $effect(() => {
        notesValue = activePhoto?.notes ?? "";
    });

    $effect(() => {
        const fallbackId = compareCandidates[0]?.photo.id ?? null;
        const hasSelection = compareCandidates.some((candidate) => candidate.photo.id === comparePhotoId);

        if (!hasSelection) {
            comparePhotoId = fallbackId;
        }
        if (!fallbackId && compareMode) {
            compareMode = false;
        }
    });

    $effect(() => {
        const node = imageViewport;
        if (!node) return;

        const updateViewportSize = () => {
            viewportWidth = node.clientWidth;
            viewportHeight = node.clientHeight;
        };

        updateViewportSize();
        const observer = new ResizeObserver(updateViewportSize);
        observer.observe(node);
        return () => observer.disconnect();
    });

    onMount(() => {
        loadCustomPresets();
        photoStore.setSelectedIndex(currentIndex);
        void loadCurrentPhoto();
    });

    onDestroy(() => {
        revokeBlobUrl(currentBlobUrl);
        revokeBlobUrl(editedPreviewUrl);
        for (const image of preloadCache.values()) {
            revokeBlobUrl(image.url);
        }
        preloadCache.clear();
    });

    function resetZoom() {
        zoomLevel = 1;
        panX = 0;
        panY = 0;
    }

    function zoomIn() {
        const nextIdx = ZOOM_STEPS.findIndex((zoom) => zoom > zoomLevel);
        if (nextIdx !== -1) zoomLevel = ZOOM_STEPS[nextIdx];
        if (zoomLevel <= 1) resetZoom();
    }

    function zoomOut() {
        const prevIdx = ZOOM_STEPS.slice().reverse().findIndex((zoom) => zoom < zoomLevel);
        if (prevIdx !== -1) zoomLevel = ZOOM_STEPS[ZOOM_STEPS.length - 1 - prevIdx];
        if (zoomLevel <= 1) resetZoom();
    }

    function handleWheel(event: WheelEvent) {
        event.preventDefault();
        if (event.deltaY < 0) zoomIn();
        else zoomOut();
    }

    function handlePointerDown(event: PointerEvent) {
        if (zoomLevel <= 1) return;
        isPanning = true;
        panStartX = event.clientX - panX;
        panStartY = event.clientY - panY;
        (event.target as HTMLElement)?.setPointerCapture?.(event.pointerId);
    }

    function handlePointerMove(event: PointerEvent) {
        if (!isPanning) return;
        panX = event.clientX - panStartX;
        panY = event.clientY - panStartY;
    }

    function handlePointerUp() {
        isPanning = false;
    }

    function handleDoubleClick() {
        if (zoomLevel === 1) zoomLevel = 3;
        else resetZoom();
    }

    function revokeBlobUrl(url: string | null) {
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    }

    function clearCurrentImageState() {
        revokeBlobUrl(currentBlobUrl);
        currentBlobUrl = null;
        currentBlobPhotoId = null;
        fullResCandidatePhotoId = null;
        loadedImagePhotoId = null;
        loadedImageUrl = null;
        loadedImageWidth = 0;
        loadedImageHeight = 0;
        hasFullRes = false;
    }

    function closeViewer() {
        photoStore.setSelectedIndex(currentIndex);
        photoStore.setViewMode("grid");
    }

    function handleBackdropClick(event: MouseEvent) {
        if (event.target === event.currentTarget) closeViewer();
    }

    function clearEditedPreview() {
        revokeBlobUrl(editedPreviewUrl);
        editedPreviewUrl = null;
    }

    function loadCustomPresets() {
        try {
            const raw = localStorage.getItem("hologram.rawPresets");
            customPresets = raw ? JSON.parse(raw) : [];
        } catch {
            customPresets = [];
        }
    }

    function saveCustomPresets(next: RawProcessingPreset[]) {
        customPresets = next;
        localStorage.setItem("hologram.rawPresets", JSON.stringify(next));
    }

    async function importPreset(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const preset = parseRawPresetFile(file.name, text);
            saveCustomPresets([preset, ...customPresets.filter((item) => item.name !== preset.name)]);
            selectedPresetId = preset.id;
            showEditor = true;
        } catch (error) {
            console.error("Failed to import preset:", error);
        } finally {
            input.value = "";
        }
    }

    function deletePreset(id: string) {
        saveCustomPresets(customPresets.filter((preset) => preset.id !== id));
        if (selectedPresetId === id) selectedPresetId = "builtin-neutral";
    }

    function applySelectedPreset() {
        if (!activePreset) return;
        showEditor = true;
    }

    function handlePresetSaved(preset: RawProcessingPreset) {
        saveCustomPresets([preset, ...customPresets.filter((item) => item.name !== preset.name)]);
        selectedPresetId = preset.id;
    }

    function navigateTo(index: number) {
        if (index < 0 || index >= photos.length) return;
        viewingRaw = false;
        clearEditedPreview();
        clearCurrentImageState();
        isLoadingFullRes = true;
        loadError = null;
        resetZoom();
        currentIndex = index;
        photoStore.setSelectedIndex(currentIndex);
        void loadCurrentPhoto();
    }

    function navigatePrevious() {
        if (hasPrevious) navigateTo(currentIndex - 1);
    }

    function navigateNext() {
        if (hasNext) navigateTo(currentIndex + 1);
    }

    function isSamePhotoSet(item: Photo | undefined): boolean {
        if (!item || !photo) return false;

        const currentIds = new Set<string>([photo.id]);
        if (photo.paired_with) currentIds.add(photo.paired_with);
        if (pairedPhoto?.id) currentIds.add(pairedPhoto.id);
        if (pairedPhoto?.paired_with) currentIds.add(pairedPhoto.paired_with);

        return currentIds.has(item.id) || (!!item.paired_with && currentIds.has(item.paired_with));
    }

    function getCompareCandidates(): CompareCandidate[] {
        const candidates: CompareCandidate[] = [];

        for (let index = 0; index < photos.length; index += 1) {
            const item = photos[index];
            if (!item || isSamePhotoSet(item)) continue;
            candidates.push({
                photo: item,
                index,
                distance: Math.abs(index - currentIndex),
            });
        }

        return candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
    }

    function compareOptionLabel(candidate: CompareCandidate): string {
        const direction =
            candidate.index > currentIndex ? `+${candidate.index - currentIndex}` : `${candidate.index - currentIndex}`;
        return `${direction}  ${candidate.photo.file_name}`;
    }

    function handleCompareSelectionChange(event: Event) {
        const select = event.currentTarget as HTMLSelectElement;
        comparePhotoId = select.value || null;
        compareMode = !!comparePhotoId;
    }

    async function toggleRawJpeg() {
        if (!isPaired) return;
        viewingRaw = !viewingRaw;
        clearEditedPreview();
        clearCurrentImageState();
        isLoadingFullRes = true;
        loadError = null;
        await tick();
        void loadPhotoByRef(activePhoto);
    }

    function isTypingTarget(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        return !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (isTypingTarget(event.target)) return;

        switch (event.key) {
            case "Escape":
                if (zoomLevel > 1) resetZoom();
                else closeViewer();
                break;
            case "ArrowLeft":
                event.preventDefault();
                navigatePrevious();
                break;
            case "ArrowRight":
                event.preventDefault();
                navigateNext();
                break;
            case "r":
            case "R":
                event.preventDefault();
                void toggleRawJpeg();
                break;
            case "p":
            case "P":
                event.preventDefault();
                setFlagForActive("pick");
                break;
            case "x":
            case "X":
                event.preventDefault();
                setFlagForActive("reject");
                break;
            case "u":
            case "U":
                event.preventDefault();
                clearCullForActive();
                break;
            case "+":
            case "=":
                event.preventDefault();
                zoomIn();
                break;
            case "-":
                event.preventDefault();
                zoomOut();
                break;
            case "f":
            case "F":
                event.preventDefault();
                resetZoom();
                break;
            case "e":
            case "E":
                event.preventDefault();
                showEditor = !showEditor;
                break;
            case "d":
            case "D":
                event.preventDefault();
                compareMode = !!comparePhoto && !compareMode;
                break;
            case "o":
            case "O":
                event.preventDefault();
                void openInEditor();
                break;
            default:
                if (/^[0-5]$/.test(event.key)) {
                    event.preventDefault();
                    setRatingForActive(Number(event.key));
                }
        }
    }

    async function openInEditor() {
        if (!activePhoto) return;
        try {
            await HologramAPI.openInEditor(activePhoto.file_path);
        } catch (error) {
            console.error("Error opening in editor:", error);
        }
    }

    function canUseOriginalAsPreview(item: Photo | undefined): boolean {
        return !!item && ["JPEG", "JPG", "PNG", "WEBP", "GIF"].includes(item.file_type.toUpperCase());
    }

    function getBrowserFileSrcRaw(item: Photo | undefined): string {
        if (!item || !canUseOriginalAsPreview(item)) return "";
        try {
            return convertFileSrc(item.file_path);
        } catch {
            return "";
        }
    }

    function getBrowserFileSrc(item: Photo | undefined): string {
        if (!item || failedPreviewIds.has(item.id)) return "";
        return getBrowserFileSrcRaw(item);
    }

    function getThumbnailDataSrcRaw(item: Photo | undefined): string {
        if (!item?.thumbnail) return "";
        const mime = item.thumbnail.startsWith("iVBOR") ? "image/png" : "image/jpeg";
        return `data:${mime};base64,${item.thumbnail}`;
    }

    function getThumbnailDataSrc(item: Photo | undefined): string {
        if (!item || failedThumbnailIds.has(item.id)) return "";
        return getThumbnailDataSrcRaw(item);
    }

    function getPreviewSrc(item: Photo | undefined): string {
        if (!item) return "";
        return getThumbnailDataSrc(item) || getBrowserFileSrc(item);
    }

    function getVisiblePreviewSrc(item: Photo | undefined): string {
        if (!item) return "";
        if (item.id === activePhoto?.id && viewingRaw && photo && photo.id !== item.id) {
            return getPreviewSrc(photo) || getPreviewSrc(item);
        }
        return getPreviewSrc(item);
    }

    function getFilmstripSrc(item: Photo | undefined): string {
        return getThumbnailDataSrc(item) || getBrowserFileSrc(item);
    }

    function markPreviewFailed(item: Photo | undefined) {
        if (!item || failedPreviewIds.has(item.id)) return;
        failedPreviewIds = new Set([...failedPreviewIds, item.id]);
    }

    function markThumbnailFailed(item: Photo | undefined) {
        if (!item || failedThumbnailIds.has(item.id)) return;
        failedThumbnailIds = new Set([...failedThumbnailIds, item.id]);
    }

    function getImageFailureKey(item: Photo, failedUrl: string): string {
        if (failedUrl === getThumbnailDataSrcRaw(item)) return `${item.id}:thumbnail`;
        if (failedUrl === getBrowserFileSrcRaw(item)) return `${item.id}:browser-file`;
        if (failedUrl === currentBlobUrl) return `${item.id}:full-resolution`;
        return `${item.id}:unknown:${failedUrl.slice(0, 96)}`;
    }

    function markFailedImageSource(item: Photo, failedUrl: string) {
        if (failedUrl === getThumbnailDataSrcRaw(item)) {
            markThumbnailFailed(item);
        }
        if (failedUrl === getBrowserFileSrcRaw(item)) {
            markPreviewFailed(item);
        }
    }

    function expectedDimensions(item: Photo | undefined): { width: number; height: number } | null {
        const width = item?.exif.width;
        const height = item?.exif.height;
        if (!width || !height) return null;
        return { width, height };
    }

    function matchesExpectedDimensions(
        naturalWidth: number,
        naturalHeight: number,
        expected: { width: number; height: number },
    ): boolean {
        const tolerance = 2;
        const direct =
            Math.abs(naturalWidth - expected.width) <= tolerance &&
            Math.abs(naturalHeight - expected.height) <= tolerance;
        const rotated =
            Math.abs(naturalWidth - expected.height) <= tolerance &&
            Math.abs(naturalHeight - expected.width) <= tolerance;
        return direct || rotated;
    }

    function getLoadedImageDimensions(): { width: number; height: number } | null {
        if (
            loadedImagePhotoId !== activePhoto?.id ||
            loadedImageUrl !== getImageSrc() ||
            loadedImageWidth <= 0 ||
            loadedImageHeight <= 0
        ) {
            return null;
        }
        return { width: loadedImageWidth, height: loadedImageHeight };
    }

    function getImageRenderStyle(): string {
        const dims = getLoadedImageDimensions();
        const transition = isPanning ? "none" : "transform 0.15s ease-out";

        if (!dims || viewportWidth <= 0 || viewportHeight <= 0) {
            return [
                "max-width: 100%",
                "max-height: 100%",
                `transform: translate(${panX}px, ${panY}px)`,
                "transform-origin: center center",
                `transition: ${transition}`,
            ].join("; ");
        }

        const fitScale = Math.min(viewportWidth / dims.width, viewportHeight / dims.height, 1);
        const renderedWidth = Math.max(1, Math.round(dims.width * fitScale * zoomLevel));
        const renderedHeight = Math.max(1, Math.round(dims.height * fitScale * zoomLevel));

        return [
            `width: ${renderedWidth}px`,
            `height: ${renderedHeight}px`,
            "max-width: none",
            "max-height: none",
            `transform: translate(${panX}px, ${panY}px)`,
            "transform-origin: center center",
            `transition: ${transition}`,
        ].join("; ");
    }

    function handleActiveImageLoad(event: Event, photoId: string) {
        const loadedPhoto = activePhoto?.id === photoId ? activePhoto : undefined;
        if (!loadedPhoto) return;

        const image = event.currentTarget as HTMLImageElement | null;
        const loadedUrl = image?.currentSrc || image?.src || "";
        if (image && loadedUrl) {
            loadedImagePhotoId = loadedPhoto.id;
            loadedImageUrl = loadedUrl;
            loadedImageWidth = image.naturalWidth;
            loadedImageHeight = image.naturalHeight;
        }

        if (!image || loadedUrl !== currentBlobUrl || currentBlobPhotoId !== loadedPhoto.id) {
            return;
        }

        if (fullResCandidatePhotoId !== loadedPhoto.id) {
            hasFullRes = false;
            isLoadingFullRes = false;
            return;
        }

        const expected = expectedDimensions(loadedPhoto);
        hasFullRes = expected
            ? matchesExpectedDimensions(image.naturalWidth, image.naturalHeight, expected)
            : canUseOriginalAsPreview(loadedPhoto);
        isLoadingFullRes = false;
    }

    async function handleActiveImageError(event: Event, photoId: string) {
        const failedPhoto = activePhoto?.id === photoId ? activePhoto : undefined;
        if (!failedPhoto) return;

        const image = event.currentTarget as HTMLImageElement | null;
        const failedUrl = image?.currentSrc || image?.src || "";

        if (failedUrl === currentBlobUrl && currentBlobPhotoId === failedPhoto.id && currentBlobUrl?.startsWith("blob:")) {
            clearCurrentImageState();
            loadError = "Failed to load full-resolution image";
            isLoadingFullRes = false;
            return;
        }

        const failureKey = getImageFailureKey(failedPhoto, failedUrl);
        if (failedImageRetryKeys.has(failureKey)) {
            markFailedImageSource(failedPhoto, failedUrl);
            isLoadingFullRes = false;
            loadError = "Failed to load image";
            return;
        }

        failedImageRetryKeys.add(failureKey);
        markFailedImageSource(failedPhoto, failedUrl);
        if (failedPhoto && !isLoadingFullRes) {
            await loadPhotoByRef(failedPhoto);
        }
    }

    function getOriginalSrc(): string {
        if (currentBlobUrl && currentBlobPhotoId === activePhoto?.id) return currentBlobUrl;
        return getVisiblePreviewSrc(activePhoto);
    }

    function getImageSrc(): string {
        if (showEditor && editedPreviewUrl) return editedPreviewUrl;
        return getOriginalSrc();
    }

    function getFullResMime(item: Photo): string {
        const type = item.file_type.toUpperCase();
        if (type === "PNG") return "image/png";
        if (type === "WEBP") return "image/webp";
        if (type === "GIF") return "image/gif";
        if (type === "TIF" || type === "TIFF") return "image/tiff";
        return "image/jpeg";
    }

    async function loadImageForPhoto(item: Photo): Promise<{ url: string | null; fullRes: boolean }> {
        try {
            const imageData = await HologramAPI.loadFullResolutionImage(item.file_path);
            if (imageData.byteLength === 0) {
                return { url: getVisiblePreviewSrc(item) || null, fullRes: false };
            }
            const uint8Array = new Uint8Array(imageData);
            const blob = new Blob([uint8Array], { type: getFullResMime(item) });
            return { url: URL.createObjectURL(blob), fullRes: true };
        } catch {
            return { url: getVisiblePreviewSrc(item) || null, fullRes: false };
        }
    }

    async function loadPhotoByRef(item: Photo | undefined) {
        if (!item) return;
        const cached = preloadCache.get(item.id);
        if (cached) {
            revokeBlobUrl(currentBlobUrl);
            currentBlobUrl = cached.url;
            currentBlobPhotoId = item.id;
            fullResCandidatePhotoId = cached.fullRes ? item.id : null;
            preloadCache.delete(item.id);
            hasFullRes = false;
            isLoadingFullRes = cached.fullRes;
            loadError = null;
            return;
        }

        isLoadingFullRes = true;
        loadError = null;
        if (currentBlobPhotoId !== item.id) {
            clearCurrentImageState();
        }

        const result = await loadImageForPhoto(item);
        if (item.id !== activePhoto?.id) {
            revokeBlobUrl(result.url);
            return;
        }

        if (result.url) {
            revokeBlobUrl(currentBlobUrl);
            currentBlobUrl = result.url;
            currentBlobPhotoId = item.id;
            fullResCandidatePhotoId = result.fullRes ? item.id : null;
            hasFullRes = false;
            isLoadingFullRes = result.fullRes;
        } else {
            loadError = "Failed to load image";
            currentBlobPhotoId = null;
            fullResCandidatePhotoId = null;
            hasFullRes = false;
            isLoadingFullRes = false;
        }
    }

    async function loadCurrentPhoto() {
        await loadPhotoByRef(activePhoto);
        preloadAdjacent();
    }

    function preloadAdjacent() {
        for (const [key, image] of preloadCache) {
            const idx = photos.findIndex((item) => item.id === key);
            if (idx === -1 || Math.abs(idx - currentIndex) > 3) {
                revokeBlobUrl(image.url);
                preloadCache.delete(key);
            }
        }

        const adjacentIndices = [currentIndex + 1, currentIndex - 1].filter(
            (idx) => idx >= 0 && idx < photos.length,
        );

        for (const idx of adjacentIndices) {
            const item = photos[idx];
            if (!item || preloadCache.has(item.id) || preloadingSet.has(item.id)) continue;
            preloadingSet.add(item.id);
            loadImageForPhoto(item).then((result) => {
                preloadingSet.delete(item.id);
                if (!result.url) return;
                const currentIdx = photos.findIndex((candidate) => candidate.id === item.id);
                if (Math.abs(currentIdx - currentIndex) <= 3) {
                    preloadCache.set(item.id, { url: result.url, fullRes: result.fullRes });
                } else {
                    revokeBlobUrl(result.url);
                }
            });
        }
    }

    function relatedIds(): string[] {
        if (!activePhoto) return [];
        return Array.from(new Set([activePhoto.id, activePhoto.paired_with].filter(Boolean) as string[]));
    }

    function setRatingForActive(rating: number) {
        for (const id of relatedIds()) {
            photoStore.setPhotoRating(id, rating);
        }
        if (rating > 0 && autoAdvance) navigateNext();
    }

    function setFlagForActive(flag: CullFlag) {
        if (!activePhoto) return;
        const next = activePhoto.flag === flag ? "none" : flag;
        for (const id of relatedIds()) {
            photoStore.setPhotoFlag(id, next);
        }
        if (next !== "none" && autoAdvance) navigateNext();
    }

    function clearCullForActive() {
        for (const id of relatedIds()) {
            photoStore.clearPhotoCull(id);
        }
    }

    function handleTagKeydown(event: KeyboardEvent) {
        if (!activePhoto) return;
        if (event.key === "Enter" && tagInput.trim()) {
            event.preventDefault();
            const newTag = tagInput.trim().toLowerCase();
            const currentTags = activePhoto.tags ?? [];
            if (!currentTags.includes(newTag)) {
                for (const id of relatedIds()) {
                    photoStore.setPhotoTags(id, [...currentTags, newTag]);
                }
            }
            tagInput = "";
        }
    }

    function removeTag(tag: string) {
        if (!activePhoto) return;
        const currentTags = activePhoto.tags ?? [];
        for (const id of relatedIds()) {
            photoStore.setPhotoTags(id, currentTags.filter((item) => item !== tag));
        }
    }

    function saveNotes() {
        if (!activePhoto) return;
        for (const id of relatedIds()) {
            photoStore.setPhotoNotes(id, notesValue);
        }
    }

    function formatFileSize(bytes: number): string {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }

    function formatDate(dateString: string): string {
        try {
            return new Date(dateString).toLocaleString();
        } catch {
            return dateString;
        }
    }

    function formatAperture(value?: number): string {
        if (!value) return "";
        return `f/${value.toFixed(value % 1 === 0 ? 0 : 1)}`;
    }

    function formatFocalLength(value?: number): string {
        if (!value) return "";
        return `${Math.round(value)}mm`;
    }

    function formatEv(value?: number): string {
        if (value == null) return "";
        const rounded = Math.abs(value) < 0.05 ? 0 : value;
        const sign = rounded > 0 ? "+" : "";
        return `${sign}${rounded.toFixed(1)} EV`;
    }

    function formatEv100(value?: number): string {
        if (value == null) return "";
        return `EV ${value.toFixed(1)}`;
    }

    function formatMegapixels(width?: number, height?: number): string {
        if (!width || !height) return "";
        return `${((width * height) / 1_000_000).toFixed(1)} MP`;
    }

    function formatLocation(latitude?: number, longitude?: number, altitude?: number): string {
        if (latitude == null || longitude == null) return "";
        const coordinates = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        if (altitude == null) return coordinates;
        return `${coordinates} / ${Math.round(altitude)}m`;
    }

    function embeddedPreviewInfo(item: Photo | undefined): EmbeddedPreview | null {
        return item?.embedded_jpeg_preview ?? item?.paired_raw_embedded_jpeg_preview ?? null;
    }

    function formatEmbeddedPreview(preview: EmbeddedPreview): string {
        const dimensions = preview.width && preview.height ? `${preview.width} x ${preview.height}` : "JPEG";
        const size = preview.byte_size ? ` / ${formatFileSize(preview.byte_size)}` : "";
        return `${dimensions}${size}`;
    }

    function embeddedPreviewTitle(preview: EmbeddedPreview): string {
        return `RAW includes an embedded JPEG preview (${formatEmbeddedPreview(preview)}). Consider shooting RAW only instead of RAW+JPEG.`;
    }

    function metadataRows(item: Photo) {
        const embeddedPreview = embeddedPreviewInfo(item);
        return [
            ["File name", item.file_name],
            ["Path", item.file_path],
            ["Type", item.file_type],
            ["Size", formatFileSize(item.file_size)],
            ["Embedded JPEG preview", embeddedPreview ? formatEmbeddedPreview(embeddedPreview) : undefined],
            ["Modified", formatDate(item.modified_at)],
            ["Camera make", item.exif.camera_make],
            ["Camera model", item.exif.camera_model],
            ["Lens", item.exif.lens_model],
            ["Focal length", formatFocalLength(item.exif.focal_length)],
            ["Aperture", formatAperture(item.exif.aperture)],
            ["Shutter", item.exif.shutter_speed],
            ["ISO", item.exif.iso?.toString()],
            ["Exposure bias", formatEv(item.exif.exposure_bias)],
            ["EV100", formatEv100(item.exif.ev100)],
            ["Exposure mode", item.exif.exposure_mode],
            ["Flash", item.exif.flash],
            ["White balance", item.exif.white_balance],
            ["Date taken", item.exif.date_taken ? formatDate(item.exif.date_taken) : undefined],
            ["Dimensions", item.exif.width && item.exif.height ? `${item.exif.width} x ${item.exif.height}` : undefined],
            ["Orientation", item.exif.orientation?.toString()],
            ["Location", formatLocation(item.exif.latitude, item.exif.longitude, item.exif.altitude)],
            ["Rating", item.rating != null ? `${item.rating} stars` : undefined],
            ["Flag", item.flag],
            ["Tags", (item.tags ?? []).join(", ")],
            ["Notes", item.notes],
        ].filter(([, value]) => value != null && value !== "") as [string, string][];
    }

    function compareLabel(item: Photo | null, fallback: string): string {
        if (!item) return fallback;
        if (pairedPhoto?.id === item.id) return is_raw_file_label(item) ? "RAW" : "JPEG";
        return fallback;
    }

    function is_raw_file_label(item: Photo): boolean {
        return !["JPEG", "JPG", "PNG", "WEBP", "GIF"].includes(item.file_type.toUpperCase());
    }

    function ratingButtonClass(active: boolean): string {
        return [
            "grid h-8 w-8 place-items-center rounded-md transition-colors",
            active ? "bg-rating text-black" : "bg-white/10 text-white/45 hover:text-rating",
        ].join(" ");
    }

    function panelRatingClass(active: boolean): string {
        return [
            "grid h-8 w-8 place-items-center rounded-md transition-colors",
            active ? "bg-rating text-black" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-rating",
        ].join(" ");
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if activePhoto}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="fixed inset-0 z-[100] flex flex-col bg-black text-white" role="dialog" tabindex="-1" onclick={handleBackdropClick}>
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-black/90 px-4">
            <div class="flex min-w-0 items-center gap-4">
                <div class="min-w-0">
                    <h2 class="truncate text-sm font-semibold tracking-normal text-white">{activePhoto.file_name}</h2>
                    <div class="text-xs tabular-nums text-white/45">{currentIndex + 1} / {photos.length}</div>
                </div>

                {#if isPaired}
                    <button
                        class="rounded-md px-3 py-1.5 text-xs font-bold transition-colors {viewingRaw ? 'bg-orange-600 text-white' : 'bg-sky-600 text-white'}"
                        onclick={(event) => {
                            event.stopPropagation();
                            void toggleRawJpeg();
                        }}
                    >
                        {viewingRaw ? "RAW" : "JPEG"}
                    </button>
                {/if}

                {#if activeEmbeddedPreview}
                    <span
                        class="grid h-7 w-7 place-items-center rounded-full bg-primary/90 text-primary-foreground"
                        title={embeddedPreviewTitle(activeEmbeddedPreview)}
                        aria-label="RAW includes embedded JPEG preview"
                    >
                        <Info size={14} />
                    </span>
                {/if}

                {#if activePhoto.flag === "pick"}
                    <span class="inline-flex items-center gap-1 rounded-full bg-pick px-2 py-0.5 text-xs font-bold text-black">
                        <Check size={12} />
                        Pick
                    </span>
                {:else if activePhoto.flag === "reject"}
                    <span class="inline-flex items-center gap-1 rounded-full bg-reject px-2 py-0.5 text-xs font-bold text-white">
                        <XCircle size={12} />
                        Reject
                    </span>
                {/if}
            </div>

            <div class="flex items-center gap-2">
                <div class="hidden items-center gap-1 md:flex">
                    {#each [1, 2, 3, 4, 5] as rating}
                        <button
                            class={ratingButtonClass((activePhoto.rating ?? 0) >= rating)}
                            onclick={(event) => {
                                event.stopPropagation();
                                setRatingForActive(activePhoto.rating === rating ? 0 : rating);
                            }}
                            title={`${rating} stars`}
                        >
                            <Star size={15} fill="currentColor" />
                        </button>
                    {/each}
                </div>

                <button
                    class="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/10 px-3 text-xs font-semibold text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    class:bg-primary={compareMode}
                    class:text-primary-foreground={compareMode}
                    onclick={(event) => {
                        event.stopPropagation();
                        compareMode = !!comparePhoto && !compareMode;
                    }}
                    disabled={!comparePhoto}
                    title={comparePhoto ? `Compare with ${comparePhoto.file_name}` : "No other photo to compare"}
                >
                    <Columns2 size={14} />
                    Compare
                </button>
                {#if compareCandidates.length > 0}
                    <select
                        class="h-8 w-32 max-w-[28vw] rounded-md border border-white/10 bg-white/10 px-2 text-xs font-semibold text-white/75 outline-none transition-colors hover:bg-white/15 focus:border-primary sm:w-48 md:w-64"
                        bind:value={comparePhotoId}
                        onclick={(event) => event.stopPropagation()}
                        onchange={handleCompareSelectionChange}
                        title="Choose comparison photo"
                    >
                        {#each compareCandidates as candidate (candidate.photo.id)}
                            <option class="bg-black text-white" value={candidate.photo.id}>
                                {compareOptionLabel(candidate)}
                            </option>
                        {/each}
                    </select>
                {/if}
                <button
                    class="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/10 px-3 text-xs font-semibold text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onclick={(event) => {
                        event.stopPropagation();
                        showEditor = !showEditor;
                    }}
                    title="Adjust"
                >
                    <SlidersHorizontal size={14} />
                    Edit
                </button>
                <button
                    class="grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onclick={(event) => {
                        event.stopPropagation();
                        void openInEditor();
                    }}
                    title="Open externally"
                >
                    <ExternalLink size={15} />
                </button>
                <button
                    class="grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                    onclick={(event) => {
                        event.stopPropagation();
                        closeViewer();
                    }}
                    title="Close"
                >
                    <X size={18} />
                </button>
            </div>
        </header>

        <div class="flex min-h-0 flex-1">
            <section class="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black">
                {#if hasPrevious}
                    <button
                        class="absolute left-4 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white/60 transition-colors hover:bg-black/75 hover:text-white"
                        onclick={navigatePrevious}
                        title="Previous"
                    >
                        <ChevronLeft size={26} />
                    </button>
                {/if}

                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    bind:this={imageViewport}
                    class="relative flex h-full w-full items-center justify-center overflow-hidden"
                    onwheel={handleWheel}
                    onpointerdown={handlePointerDown}
                    onpointermove={handlePointerMove}
                    onpointerup={handlePointerUp}
                    ondblclick={handleDoubleClick}
                    style="cursor: {zoomLevel > 1 ? (isPanning ? 'grabbing' : 'grab') : 'default'};"
                >
                    {#if isLoadingFullRes}
                        <div class="absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white/80">
                            <Loader2 size={14} class="animate-spin" />
                            Loading
                        </div>
                    {/if}

                    {#if loadError && !getImageSrc()}
                        <div class="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/55">
                            <p>{loadError}</p>
                        </div>
                    {:else if compareMode && comparePhoto}
                        <div class="grid h-full w-full grid-cols-2 gap-px bg-white/10">
                            <div class="relative flex min-w-0 items-center justify-center overflow-hidden bg-black">
                                <div class="absolute left-3 top-3 z-10 rounded-full bg-black/70 px-2 py-0.5 text-xs font-semibold text-white/75">
                                    {compareLabel(activePhoto, "Active")}
                                </div>
                                <img
                                    src={getImageSrc()}
                                    alt={activePhoto.file_name}
                                    class="photo-preview-image max-h-full max-w-full object-contain"
                                    draggable="false"
                                    onload={(event) => handleActiveImageLoad(event, activePhoto.id)}
                                    onerror={(event) => void handleActiveImageError(event, activePhoto.id)}
                                />
                                <div class="absolute inset-x-3 bottom-3 truncate rounded-full bg-black/70 px-2 py-0.5 text-center text-xs text-white/65">
                                    {activePhoto.file_name}
                                </div>
                            </div>
                            <div class="relative flex min-w-0 items-center justify-center overflow-hidden bg-black">
                                <div class="absolute left-3 top-3 z-10 rounded-full bg-black/70 px-2 py-0.5 text-xs font-semibold text-white/75">
                                    {compareLabel(comparePhoto, "Compare")}
                                </div>
                                {#if getVisiblePreviewSrc(comparePhoto)}
                                    <img
                                        src={getVisiblePreviewSrc(comparePhoto)}
                                        alt={comparePhoto.file_name}
                                        class="photo-preview-image max-h-full max-w-full object-contain"
                                        draggable="false"
                                    />
                                {:else}
                                    <div class="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/55">
                                        <p>No preview</p>
                                    </div>
                                {/if}
                                <div class="absolute inset-x-3 bottom-3 truncate rounded-full bg-black/70 px-2 py-0.5 text-center text-xs text-white/65">
                                    {comparePhoto.file_name}
                                </div>
                            </div>
                        </div>
                    {:else}
                        <img
                            src={getImageSrc()}
                            alt={activePhoto.file_name}
                            class="photo-preview-image block shrink-0 select-none object-contain"
                            class:opacity-55={isLoadingFullRes && !activeFullResLoaded}
                            draggable="false"
                            onload={(event) => handleActiveImageLoad(event, activePhoto.id)}
                            onerror={(event) => void handleActiveImageError(event, activePhoto.id)}
                            style={getImageRenderStyle()}
                        />
                    {/if}

                    <div class="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/70 px-2 py-1">
                        <button class="p-1 text-white/65 transition-colors hover:text-white" onclick={zoomOut} title="Zoom out">
                            <ZoomOut size={16} />
                        </button>
                        <button class="min-w-12 px-1 text-center font-mono text-xs text-white/80 transition-colors hover:text-white" onclick={resetZoom} title="Fit">
                            {zoomPercent}%
                        </button>
                        <button class="p-1 text-white/65 transition-colors hover:text-white" onclick={zoomIn} title="Zoom in">
                            <ZoomIn size={16} />
                        </button>
                        <button class="p-1 text-white/65 transition-colors hover:text-white" onclick={resetZoom} title="Fit">
                            <Maximize2 size={16} />
                        </button>
                    </div>

                    <div class="absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
                        {#if isPaired}
                            <span class="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                                <FileImage size={12} />
                                RAW+JPEG
                            </span>
                        {/if}
                        {#if activeFullResLoaded}
                            <span class="rounded-full bg-pick px-2 py-0.5 text-xs font-bold text-black">Full Res</span>
                        {/if}
                    </div>
                </div>

                {#if hasNext}
                    <button
                        class="absolute right-4 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white/60 transition-colors hover:bg-black/75 hover:text-white"
                        onclick={navigateNext}
                        title="Next"
                    >
                        <ChevronRight size={26} />
                    </button>
                {/if}
            </section>

            <aside class="h-full w-84 shrink-0 overflow-y-auto border-l border-border bg-card p-4 text-foreground">
                <section class="mb-5 rounded-lg border border-border bg-background p-3">
                    <div class="mb-3 flex items-center justify-between gap-2">
                        <h3 class="text-xs font-bold uppercase text-foreground">Cull</h3>
                        <label class="flex items-center gap-2 text-xs text-muted-foreground">
                            <input type="checkbox" bind:checked={autoAdvance} class="accent-primary" />
                            Auto advance
                        </label>
                    </div>
                    <div class="mb-3 flex items-center gap-1">
                        {#each [1, 2, 3, 4, 5] as rating}
                            <button
                                class={panelRatingClass((activePhoto.rating ?? 0) >= rating)}
                                onclick={() => setRatingForActive(activePhoto.rating === rating ? 0 : rating)}
                                title={`${rating} stars`}
                            >
                                <Star size={15} fill="currentColor" />
                            </button>
                        {/each}
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <button
                            class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-secondary text-xs font-semibold text-muted-foreground transition-colors hover:bg-pick hover:text-black"
                            onclick={() => setFlagForActive("pick")}
                        >
                            <Check size={14} />
                            Pick
                        </button>
                        <button
                            class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-secondary text-xs font-semibold text-muted-foreground transition-colors hover:bg-reject hover:text-white"
                            onclick={() => setFlagForActive("reject")}
                        >
                            <XCircle size={14} />
                            Reject
                        </button>
                        <button
                            class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-secondary text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            onclick={clearCullForActive}
                        >
                            <Circle size={14} />
                            Clear
                        </button>
                    </div>
                </section>

                <section class="mb-5 rounded-lg border border-border bg-background p-3">
                    <div class="mb-3 flex items-center justify-between gap-2">
                        <h3 class="text-xs font-bold uppercase text-foreground">RAW Presets</h3>
                        <button
                            class="grid h-7 w-7 place-items-center rounded-md bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            onclick={() => presetInput?.click()}
                            title="Import preset"
                        >
                            <Upload size={13} />
                        </button>
                        <input
                            bind:this={presetInput}
                            type="file"
                            accept=".xmp,.cube,.json"
                            class="hidden"
                            onchange={(event) => void importPreset(event)}
                        />
                    </div>
                    <div class="space-y-2">
                        <div class="flex gap-2">
                            <select
                                class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/40"
                                bind:value={selectedPresetId}
                            >
                                {#each allPresets as preset (preset.id)}
                                    <option value={preset.id}>{preset.name}</option>
                                {/each}
                            </select>
                            <button
                                class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                                onclick={applySelectedPreset}
                            >
                                Apply
                            </button>
                            {#if activePreset && activePreset.source !== "built-in"}
                                <button
                                    class="grid h-8 w-8 place-items-center rounded-md bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-reject"
                                    onclick={() => deletePreset(activePreset!.id)}
                                    title="Delete preset"
                                >
                                    <Trash2 size={13} />
                                </button>
                            {/if}
                        </div>
                        {#if activePreset}
                            <div class="rounded-md bg-secondary p-2 text-[11px] text-muted-foreground">
                                <div class="font-semibold text-foreground">{presetSummary(activePreset)}</div>
                                {#if activePreset.notes}
                                    <div class="mt-1">{activePreset.notes}</div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                </section>

                {#if showEditor}
                    <ImageEditor
                        imageSrc={getOriginalSrc()}
                        filePath={activePhoto.file_path}
                        preset={activePreset}
                        onPresetSaved={handlePresetSaved}
                        onPreview={(url) => {
                            revokeBlobUrl(editedPreviewUrl);
                            editedPreviewUrl = url;
                        }}
                    />
                    <div class="my-5 border-t border-border"></div>
                {/if}

                <section class="space-y-4">
                    <div>
                        <h3 class="mb-2 text-xs font-bold uppercase text-foreground">File</h3>
                        <div class="space-y-2 text-sm text-muted-foreground">
                            <div class="flex items-center gap-2">
                                <FileImage size={14} class="shrink-0" />
                                <span>{activePhoto.file_type} / {formatFileSize(activePhoto.file_size)}</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <Calendar size={14} class="shrink-0" />
                                <span>{formatDate(activePhoto.modified_at)}</span>
                            </div>
                        </div>
                    </div>

                    <div>
                        <h3 class="mb-2 text-xs font-bold uppercase text-foreground">Camera</h3>
                        <div class="space-y-2 text-sm text-muted-foreground">
                            {#if activePhoto.exif.camera_model || activePhoto.exif.camera_make}
                                <div class="flex items-center gap-2">
                                    <Camera size={14} class="shrink-0" />
                                    <span>{activePhoto.exif.camera_make ?? ""} {activePhoto.exif.camera_model ?? ""}</span>
                                </div>
                            {/if}
                            {#if activePhoto.exif.lens_model}
                                <div class="flex items-center gap-2">
                                    <Aperture size={14} class="shrink-0" />
                                    <span>{activePhoto.exif.lens_model}</span>
                                </div>
                            {/if}
                        </div>
                    </div>

                    <div>
                        <h3 class="mb-2 text-xs font-bold uppercase text-foreground">Exposure</h3>
                        <div class="grid grid-cols-2 gap-2 text-sm">
                            {#if activePhoto.exif.aperture}
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">Aperture</div>
                                    <div class="font-semibold text-foreground">{formatAperture(activePhoto.exif.aperture)}</div>
                                </div>
                            {/if}
                            {#if activePhoto.exif.shutter_speed}
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">Shutter</div>
                                    <div class="font-semibold text-foreground">{activePhoto.exif.shutter_speed}</div>
                                </div>
                            {/if}
                            {#if activePhoto.exif.iso}
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">ISO</div>
                                    <div class="font-semibold text-foreground">{activePhoto.exif.iso}</div>
                                </div>
                            {/if}
                            {#if activePhoto.exif.focal_length}
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">Focal</div>
                                    <div class="font-semibold text-foreground">{formatFocalLength(activePhoto.exif.focal_length)}</div>
                                </div>
                            {/if}
                            {#if activePhoto.exif.exposure_bias != null}
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">Bias</div>
                                    <div class="font-semibold text-foreground">{formatEv(activePhoto.exif.exposure_bias)}</div>
                                </div>
                            {/if}
                            {#if activePhoto.exif.ev100 != null}
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">EV100</div>
                                    <div class="font-semibold text-foreground">{formatEv100(activePhoto.exif.ev100)}</div>
                                </div>
                            {/if}
                        </div>
                    </div>

                    {#if activePhoto.exif.width && activePhoto.exif.height}
                        <div>
                            <h3 class="mb-2 text-xs font-bold uppercase text-foreground">Dimensions</h3>
                            <div class="grid grid-cols-2 gap-2 text-sm">
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">Pixels</div>
                                    <div class="font-mono text-sm tabular-nums text-foreground">
                                        {activePhoto.exif.width} x {activePhoto.exif.height}
                                    </div>
                                </div>
                                <div class="rounded-md bg-secondary p-2">
                                    <div class="text-xs text-muted-foreground">Megapixels</div>
                                    <div class="font-semibold text-foreground">
                                        {formatMegapixels(activePhoto.exif.width, activePhoto.exif.height)}
                                    </div>
                                </div>
                            </div>
                        </div>
                    {/if}

                    {#if activePhoto.exif.latitude != null && activePhoto.exif.longitude != null}
                        <div>
                            <h3 class="mb-2 text-xs font-bold uppercase text-foreground">Location</h3>
                            <div class="flex items-center gap-2 text-sm text-muted-foreground">
                                <MapPin size={14} class="shrink-0" />
                                <span class="font-mono tabular-nums">
                                    {formatLocation(activePhoto.exif.latitude, activePhoto.exif.longitude, activePhoto.exif.altitude)}
                                </span>
                            </div>
                        </div>
                    {/if}

                    <div>
                        <h3 class="mb-2 text-xs font-bold uppercase text-foreground">Full Metadata</h3>
                        <div class="max-h-72 overflow-y-auto rounded-md border border-border">
                            {#each metadataRows(activePhoto) as [label, value]}
                                <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 border-b border-border px-2 py-1.5 text-xs last:border-b-0">
                                    <div class="text-muted-foreground">{label}</div>
                                    <div class="min-w-0 break-words font-mono text-[11px] text-foreground">{value}</div>
                                </div>
                            {/each}
                        </div>
                    </div>

                    <div class="border-t border-border pt-4">
                        <h3 class="mb-2 text-xs font-bold uppercase text-foreground">Tags & Notes</h3>
                        <div class="mb-2 flex min-h-6 flex-wrap gap-1">
                            {#each (activePhoto.tags ?? []) as tag}
                                <span class="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-xs text-primary">
                                    {tag}
                                    <button onclick={() => removeTag(tag)} class="hover:text-reject" aria-label="Remove tag">
                                        <X size={10} />
                                    </button>
                                </span>
                            {/each}
                        </div>
                        <input
                            type="text"
                            placeholder="Add tag"
                            class="mb-2 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40"
                            bind:value={tagInput}
                            onkeydown={handleTagKeydown}
                        />
                        <textarea
                            placeholder="Notes"
                            rows="4"
                            class="w-full resize-none rounded-md border border-input bg-background px-2 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40"
                            bind:value={notesValue}
                            onblur={saveNotes}
                        ></textarea>
                    </div>
                </section>
            </aside>
        </div>

        <footer class="flex h-24 shrink-0 items-center gap-2 overflow-x-auto border-t border-white/10 bg-black/90 px-3">
            {#each filmstripPhotos as item, i (item.id)}
                {@const actualIndex = filmstripStart + i}
                {@const previewSrc = getFilmstripSrc(item)}
                <button
                    class="relative h-16 w-24 shrink-0 overflow-hidden rounded-md border transition-colors {actualIndex === currentIndex ? 'border-primary' : 'border-white/15 hover:border-white/45'}"
                    onclick={() => navigateTo(actualIndex)}
                    title={item.file_name}
                >
                    {#if previewSrc}
                        <img
                            src={previewSrc}
                            alt={item.file_name}
                            class="photo-preview-image h-full w-full object-cover"
                            loading="lazy"
                            decoding="async"
                            onerror={() => markPreviewFailed(item)}
                        />
                    {:else}
                        <div class="grid h-full w-full place-items-center bg-white/5 text-white/30">
                            <Image size={16} />
                        </div>
                    {/if}
                    <div class="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[10px] text-white/75">
                        {item.file_name}
                    </div>
                    {#if item.flag === "pick"}
                        <span class="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-pick text-black">
                            <Check size={10} />
                        </span>
                    {:else if item.flag === "reject"}
                        <span class="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-reject text-white">
                            <XCircle size={10} />
                        </span>
                    {/if}
                </button>
            {/each}
        </footer>
    </div>
{/if}
