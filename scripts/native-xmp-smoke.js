(async () => {
  if (window.__HOLOGRAM_XMP_SMOKE_RUNNING__) return;
  window.__HOLOGRAM_XMP_SMOKE_RUNNING__ = true;
  window.__HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__ = true;
  const started = performance.now();
  const checks = [];
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test, message, timeout = 30_000) => {
    const expires = performance.now() + timeout;
    while (performance.now() < expires) {
      const value = test();
      if (value) return value;
      await delay(30);
    }
    throw new Error(`Timed out: ${message}`);
  };
  const click = async (selector, scope = document) => {
    const element = await until(() => scope.querySelector(selector), selector);
    if (element.disabled) throw new Error(`Disabled control: ${selector}`);
    element.click();
    await delay(30);
  };
  const press = async (key, modifiers = {}) => {
    document.activeElement?.blur?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
    await delay(50);
  };
  try {
    const { HologramAPI } = await import('/src/lib/api.ts');
    const { photoStore } = await import('/src/lib/stores/photoStore.ts');
    const taste = await import('/src/lib/autocull.ts');
    const plan = await import('/src/lib/autocullPlan.ts');
    const review = await import('/src/lib/autocullReview.ts');
    const fixture = await invoke('autocull_smoke_fixture');
    const id = (filename) => `xmp-smoke-${filename}`;
    const filenames = ['original.jpg', 'duplicate.jpg', 'blurred.jpg', 'black.jpg', 'white.jpg',
      'stars.jpg', 'unrated.jpg', 'colors.jpg', 'broken.jpg', 'pair.CR2', 'pair.JPG'];
    const image = new Image();
    image.src = `data:image/jpeg;base64,${fixture.portrait}`;
    await image.decode();
    const allPhotos = filenames.map((filename, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 160;
      const context = canvas.getContext('2d');
      if (filename === 'blurred.jpg') context.filter = 'blur(2px)';
      context.drawImage(image, 0, 0, 160, 160);
      if (filename === 'black.jpg' || filename === 'white.jpg') {
        context.fillStyle = filename === 'black.jpg' ? 'black' : 'white';
        context.fillRect(0, 0, 160, 160);
      }
      return {
        id: id(filename), file_name: filename, file_path: `${fixture.folder}/${filename}`, file_size: 100,
        file_type: filename.endsWith('.CR2') ? 'CR2' : 'JPEG', thumbnail: canvas.toDataURL('image/png').split(',')[1],
        exif: { date_taken: index < 3 ? new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() : new Date(Date.UTC(2026, 0, index + 1)).toISOString() },
        created_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z', flag: 'none', rating: 0,
        ...(filename === 'pair.CR2' ? { paired_with: id('pair.JPG') } : filename === 'pair.JPG' ? { paired_with: id('pair.CR2') } : {}),
      };
    });
    const automatic = () => plan.loadAutomaticDecisions(localStorage, fixture.folder);
    const feedback = () => ({ refinements: taste.loadPreferenceRefinements(), pairs: taste.loadPairwisePreferences() });
    const decisions = () => photoStore.photos.map((photo) => [photo.id, photo.flag, photo.rating]);
    const metadata = () => HologramAPI.getPhotoMetadata(allPhotos.map((photo) => photo.id), fixture.folder);
    const phase = localStorage.getItem('hologram.xmp-smoke.phase');
    HologramAPI.setActiveFolderPath(fixture.folder);
    if (phase === 'reload') {
      const previous = JSON.parse(localStorage.getItem('hologram.xmp-smoke.result'));
      photoStore.setPhotos(allPhotos);
      await photoStore.loadMetadata(allPhotos.map((photo) => photo.id));
      check(equal(await metadata(), previous.metadata), 'catalog metadata and import revisions survive a real webview reload');
      check(equal(decisions(), previous.decisions), 'reloaded photo store displays the persisted imported decisions');
      check(equal(feedback(), previous.feedback), 'imported human taste feedback survives reload without duplicate changes');
      check(!Object.hasOwn(automatic(), id('black.jpg')) && !Object.hasOwn(automatic(), id('white.jpg')), 'reloaded import is never reclassified as an automatic guess');
      await click('[aria-label="AutoCull"]');
      const view = await until(() => document.querySelector('[data-autocull-view]'), 'AutoCull view after reload');
      await until(() => view.getAttribute('data-autocull-active-learner') === 'builtin' && !view.querySelector('.animate-spin'), 'reloaded built-in analysis');
      check(view.querySelector('[aria-label="Undo"]').disabled, 'fresh AutoCull history cannot undo a completed import');
      await invoke('report_autocull_smoke', { result: { ok: true, checks: [...previous.checks, ...checks],
        metadata: await metadata(), summary: previous.summary, elapsed_ms: previous.elapsed_ms + performance.now() - started } });
      return;
    }
    localStorage.clear();
    localStorage.setItem('hologram.autocull.learner.v1', 'builtin');
    photoStore.setPhotos(allPhotos.slice(0, 5));
    await click('[aria-label="AutoCull"]');
    const view = await until(() => document.querySelector('[data-autocull-view]'), 'AutoCull view');
    await until(() => view.querySelector('[data-autocull-apply]') && !view.querySelector('[data-autocull-apply]').disabled, 'automatic plan');
    await click('[data-autocull-apply]', view);
    await until(() => view.querySelector('[data-autocull-overview-state="applied"]'), 'automatic pass applied');
    check(automatic()[id('black.jpg')]?.flag === 'reject', 'real AutoCull creates the same rejection later imported from darktable');
    check(automatic()[id('white.jpg')]?.flag === 'reject', 'real AutoCull creates a second rejection for confirmation-only Undo');
    const automaticResolutions = review.loadResolutions(localStorage, fixture.folder, 'default', 'default');
    check(Object.keys(automaticResolutions).length > 0, 'the automatic pass closes a real multi-photo stack');
    await click('[data-autocull-review-exceptions]', view);
    await click('[data-filter="all"]', view);
    const whiteStack = [...view.querySelectorAll('[data-stack-key]')].find((element) => element.getAttribute('data-stack-key').split('|').includes(id('white.jpg')));
    check(Boolean(whiteStack), 'the automatic white rejection remains reachable in review');
    whiteStack.click();
    await delay(50);
    const whiteFrame = view.querySelector(`[data-autocull-photo-id="${CSS.escape(id('white.jpg'))}"]`);
    whiteFrame?.click();
    const beforeConfirmation = decisions();
    await press('x');
    await until(() => !Object.hasOwn(automatic(), id('white.jpg')), 'human confirms an unchanged automatic rejection');
    check(equal(decisions(), beforeConfirmation), 'same-value confirmation creates no flag or star changes');
    check(!view.querySelector('[aria-label="Undo"]').disabled, 'confirmation-only Undo exists before import');
    await click('[aria-label="Export"]');
    const existing = new Map(photoStore.photos.map((photo) => [photo.id, photo]));
    photoStore.setPhotos(allPhotos.map((photo) => existing.get(photo.id) ?? photo));
    for (const filename of ['colors.jpg', 'broken.jpg']) {
      photoStore.setPhotoFlag(id(filename), 'pick');
      photoStore.setPhotoRating(id(filename), 2);
    }
    photoStore.setPhotoFlag(id('unrated.jpg'), 'reject');
    photoStore.setPhotoRating(id('unrated.jpg'), 5);
    await photoStore.flushMetadataWrites();
    taste.savePreferenceFeedback('default', [...feedback().refinements,
      ...['colors.jpg', 'broken.jpg', 'unrated.jpg'].map((filename) => ({
        photo_id: id(filename), flag: filename === 'unrated.jpg' ? 'reject' : 'pick',
        rating: filename === 'unrated.jpg' ? 5 : 2, confidence: 1, source: 'manual_decision', updated_at: '2026-01-01T00:00:00Z',
      })),
    ], feedback().pairs);
    check(automatic()[id('black.jpg')]?.flag === 'reject', 'the cached session still owns the equal-valued automatic rejection before import');
    const runImport = async () => {
      await click('[data-xmp-import]');
      const result = await until(() => {
        const element = document.querySelector('[data-xmp-import-result]');
        const button = document.querySelector('[data-xmp-import]');
        return element && button && !button.disabled ? element : null;
      }, 'XMP import result');
      check(!document.querySelector('[data-xmp-import-error]'), 'native import and frontend reconciliation finish without an operational error');
      return { text: result.textContent, imported: Number(result.dataset.imported), unchanged: Number(result.dataset.unchanged),
        skipped: Number(result.dataset.skipped), errors: Number(result.dataset.errors) };
    };
    const summary = await runImport();
    check(summary.imported === 9 && summary.skipped === 1 && summary.errors === 1, 'UI reports nine imports, one unsupported-only skip and one malformed error');
    const first = await metadata();
    const photo = (filename) => photoStore.photos.find((item) => item.id === id(filename));
    check(photo('black.jpg').flag === 'reject' && photo('black.jpg').rating === 0, 'negative darktable rating is displayed as reject with zero stars');
    check(photo('stars.jpg').rating === 3 && photo('stars.jpg').flag === 'none', 'imported stars do not invent a pick');
    check(photo('original.jpg').flag === 'none' && photo('duplicate.jpg').flag === 'none', 'non-rejected XMP ratings replace old automatic flags without promoting a pick');
    check(photo('stars.jpg').notes === 'Imported ★' && equal(photo('stars.jpg').tags, ['client & review']), 'namespace XML metadata reaches the displayed photo with entity decoding');
    check(photo('unrated.jpg').rating === 0 && photo('unrated.jpg').flag === 'none', 'unrated import clears previous stars and rejection');
    check(photo('colors.jpg').flag === 'pick' && photo('colors.jpg').rating === 2, 'color labels and processing history do not overwrite culling data');
    check(photo('broken.jpg').flag === 'pick' && photo('broken.jpg').rating === 2, 'malformed XML preserves valid existing decisions');
    check(photo('pair.CR2').rating === 5 && photo('pair.CR2').flag === 'none' && photo('pair.JPG').rating === 0 && photo('pair.JPG').flag === 'reject', 'RAW and JPEG import their own sidecars without cross-file decision propagation');
    check(!Object.hasOwn(automatic(), id('black.jpg')), 'same-valued imported rejection releases automatic ownership');
    check(feedback().refinements.some((row) => row.photo_id === id('black.jpg') && row.flag === 'reject' && row.source === 'manual_decision'), 'same-valued darktable rejection becomes human taste feedback');
    check(Object.keys(review.loadResolutions(localStorage, fixture.folder, 'default', 'default')).length === 0, 'import invalidates finished stacks affected by external decisions');
    const secondSummary = await runImport();
    check(secondSummary.imported === 0 && secondSummary.unchanged === 9, 'repeat UI import truthfully reports unchanged accepted sidecars');
    check(equal(await metadata(), first), 'repeat import preserves persisted metadata and revision identities');
    const afterImport = decisions();
    const afterFeedback = feedback();
    await click('[aria-label="AutoCull"]');
    await until(() => view.getAttribute('data-autocull-active-learner') === 'builtin' && !view.querySelector('.animate-spin'), 'cached AutoCull refresh after import');
    check(view.querySelector('[aria-label="Undo"]').disabled, 'cached confirmation-only Undo is cleared after external import');
    await press('z', { ctrlKey: true });
    await photoStore.flushMetadataWrites();
    check(equal(decisions(), afterImport) && equal(await metadata(), first), 'keyboard Undo cannot overwrite imported decisions or persisted metadata');
    check(!Object.hasOwn(automatic(), id('white.jpg')), 'stale Undo cannot restore automatic ownership of a confirmed imported photo');
    check(equal(feedback(), afterFeedback), 'cached AutoCull and stale Undo preserve imported human feedback');
    const browse = view.querySelector('[data-autocull-review-exceptions]')
      ?? [...view.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Review manually instead');
    check(Boolean(browse), 'the refreshed AutoCull result offers a review action');
    browse.click();
    await delay(50);
    await click('[data-filter="all"]', view);
    const selectImportedPhoto = async (filename) => {
      const row = [...view.querySelectorAll('[data-stack-key]')].find((element) => element.getAttribute('data-stack-key').split('|').includes(id(filename)));
      check(Boolean(row), `${filename} is reachable in the refreshed review queue`);
      row.click();
      await delay(50);
      view.querySelector(`[data-autocull-photo-id="${CSS.escape(id(filename))}"]`)?.click();
      await delay(30);
    };
    await selectImportedPhoto('stars.jpg');
    const actions = view.querySelector('[data-autocull-actions]');
    check(actions.querySelector('[aria-label="3 stars"] svg').getAttribute('fill') === 'currentColor'
      && actions.querySelector('[aria-label="4 stars"] svg').getAttribute('fill') === 'none', 'cached review visibly renders exactly three imported stars');
    check(actions.querySelector('[aria-label="Keep"]').getAttribute('aria-pressed') === 'false'
      && actions.querySelector('[aria-label="Reject"]').getAttribute('aria-pressed') === 'false', 'cached review visibly keeps imported stars separate from pick and reject flags');
    await selectImportedPhoto('black.jpg');
    check(view.querySelector('[data-autocull-actions] [aria-label="Reject"]').getAttribute('aria-pressed') === 'true', 'cached review visibly renders the imported rejection');
    check(!view.querySelector('[data-autocull-provenance]'), 'cached review removes the automatic provenance badge from the equal-valued imported rejection');
    localStorage.setItem('hologram.xmp-smoke.phase', 'reload');
    localStorage.setItem('hologram.xmp-smoke.result', JSON.stringify({ checks, metadata: first, decisions: afterImport,
      feedback: feedback(), summary, elapsed_ms: performance.now() - started }));
    window.location.reload();
  } catch (error) {
    await invoke('report_autocull_smoke', { result: { ok: false, checks, error: String(error), stack: error?.stack, elapsed_ms: performance.now() - started } });
  }
})();
