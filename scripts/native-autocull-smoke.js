(async () => {
  if (window.__HOLOGRAM_NATIVE_SMOKE_RUNNING__) return;
  window.__HOLOGRAM_NATIVE_SMOKE_RUNNING__ = true;
  window.__HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__ = true;
  const started = performance.now();
  const checks = [];
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
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
  const press = async (key) => {
    document.activeElement?.blur?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await delay(50);
  };
  let automaticKey;
  const feedbackKey = 'hologram.autocull.taste.v1.feedback.default';
  const feedback = () => JSON.parse(localStorage.getItem(feedbackKey) ?? '{"refinements":[],"pairs":[]}');
  let automatic = () => ({});
  try {
    const api = await import('/src/lib/autocull.ts');
    const { HologramAPI } = await import('/src/lib/api.ts');
    const { photoStore } = await import('/src/lib/stores/photoStore.ts');
    const fixture = await invoke('autocull_smoke_fixture');
    automaticKey = `hologram.autocull.automatic.v1.${fixture.folder}`;
    const planApi = await import('/src/lib/autocullPlan.ts');
    automatic = () => planApi.loadAutomaticDecisions(localStorage, fixture.folder);
    const phase = localStorage.getItem('hologram.native-smoke.phase');
    const nativeSession = (photos, preferences = [], refinements = [], folder = fixture.folder, profile = 'default', excluded = new Set()) => api.buildAutoCullSession(
      photos, preferences, () => {}, refinements, false, folder, excluded, profile, 'xgboost-native',
    );
    if (phase === 'reload') {
      const persisted = JSON.parse(localStorage.getItem('hologram.native-smoke.targets'));
      const targets = persisted.photos;
      const refs = api.loadPreferenceRefinements();
      const pairs = api.loadPairwisePreferences();
      check(refs.length > 0 && pairs.length > 0, 'human feedback survives a real webview reload');
      check(!targets.some((photo) => refs.some((ref) => ref.photo_id === photo.id)), 'source-shoot photos are absent from the target analysis');
      const neutral = await nativeSession(targets, [], [], fixture.other_folder);
      const learned = await nativeSession(targets, pairs, refs, fixture.other_folder);
      const isolated = await nativeSession(targets, api.loadPairwisePreferences('native-untrained'), api.loadPreferenceRefinements('native-untrained'), fixture.other_folder, 'native-untrained');
      for (const session of [neutral, learned, isolated]) {
        check(session.ranker_version === 'xgboost-personal-ranker-v1', 'reload analysis uses actual native predictions');
      }
      check(learned.stats.training_examples > 0, 'durable feature snapshots teach native learning with source shoot absent');
      check(!equal(learned.photos.map((photo) => photo.personal_score), neutral.photos.map((photo) => photo.personal_score)), 'saved human choices influence native scores on another shoot');
      check(equal(isolated.photos.map((photo) => photo.personal_score), neutral.photos.map((photo) => photo.personal_score)), 'untrained profile does not inherit another profile\'s taste');
      check(equal(feedback(), persisted.feedback), 'repeated native analysis never adds its own feedback');
      await invoke('report_autocull_smoke', { result: { ok: true, checks: [...persisted.checks, ...checks], ranker_version: learned.ranker_version, training_examples: learned.stats.training_examples, elapsed_ms: persisted.elapsed_ms + performance.now() - started } });
      return;
    }
    localStorage.clear();
    localStorage.setItem('hologram.autocull.learner.v1', 'xgboost-native');
    const image = new Image();
    image.src = `data:image/jpeg;base64,${fixture.portrait}`;
    await image.decode();
    const variants = ['original', 'duplicate', 'blurred', 'black', 'white'];
    const photos = variants.map((id, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 160;
      const context = canvas.getContext('2d');
      if (id === 'blurred') context.filter = 'blur(2px)';
      context.drawImage(image, 0, 0, 160, 160);
      if (id === 'black' || id === 'white') {
        context.fillStyle = id;
        context.fillRect(0, 0, 160, 160);
      }
      return {
        id: `native-smoke-${id}`, file_name: `${id}.jpg`, file_path: `${fixture.folder}/${id}.jpg`, file_size: 100,
        file_type: 'JPEG', thumbnail: canvas.toDataURL('image/png').split(',')[1],
        exif: { date_taken: index < 3 ? new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() : new Date(Date.UTC(2026, 0, index + 1)).toISOString() },
        created_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z', flag: 'none', rating: 0,
      };
    });
    HologramAPI.setActiveFolderPath(fixture.folder);
    photoStore.setPhotos(photos);
    await click('[aria-label="AutoCull"]');
    const view = await until(() => document.querySelector('[data-autocull-view]'), 'AutoCull view');
    const waitNative = async () => {
      await until(() => view.querySelector('[data-autocull-session-learner="xgboost-native"]'), 'native session marker');
      await until(() => !view.querySelector('.animate-spin'), 'native analysis completes');
    };
    await waitNative();
    check(Boolean(view.querySelector('[data-autocull-session-learner="xgboost-native"]')), 'the real AutoCull UI publishes a native-engine session');
    const beforeAutomatic = feedback();
    const beforeDecisions = photoStore.photos.map((photo) => [photo.id, photo.flag, photo.rating]);
    await click('[data-autocull-apply]', view);
    await until(() => view.querySelector('[data-autocull-overview-state="applied"]'), 'automatic pass applied');
    const autoIds = Object.keys(automatic());
    check(autoIds.length > 0, 'native analysis produces an automatic decision plan');
    check(equal(feedback(), beforeAutomatic), 'automatic application creates no human training labels');
    check(!equal(photoStore.photos.map((photo) => [photo.id, photo.flag, photo.rating]), beforeDecisions), 'automatic apply changes real application decisions');
    await click('[aria-label="Refresh analysis"]', view);
    await waitNative();
    await click('[data-autocull-review-exceptions]', view);
    await click('[data-filter="all"]', view);
    const advanced = await until(() => view.querySelector('[data-autocull-advanced]'), 'advanced inspector');
    if (!advanced.open) await click('summary', advanced);
    const trainingCount = () => Number(advanced.textContent.match(/(\d+) preferences learned/)?.[1] ?? -1);
    check(trainingCount() === 0, 'repeated native analysis excludes automatic guesses from training');
    const autoId = autoIds.find((id) => [...view.querySelectorAll('[data-stack-key]')].some((row) => row.getAttribute('data-stack-key') === id)) ?? autoIds[0];
    const autoRow = () => [...view.querySelectorAll('[data-stack-key]')].find((row) => row.getAttribute('data-stack-key').split('|').includes(autoId));
    check(Boolean(autoRow()), 'automatically decided frame remains reachable for human review');
    autoRow().click();
    await delay(50);
    const frame = view.querySelector(`[data-autocull-photo-id="${CSS.escape(autoId)}"]`);
    frame?.click();
    await press('Enter');
    await until(() => !Object.hasOwn(automatic(), autoId), 'confirmation releases automatic ownership');
    check(feedback().refinements.some((row) => row.photo_id === autoId), 'human confirmation teaches the active profile');
    const confirmedRun = await nativeSession(photoStore.photos, api.loadPairwisePreferences(), api.loadPreferenceRefinements(), fixture.folder, 'default', planApi.automaticPhotoIds(photoStore.photos, automatic()));
    check(confirmedRun.stats.training_examples > 0 && confirmedRun.ranker_version === 'xgboost-personal-ranker-v1', 'actual native training consumes explicitly confirmed feedback');
    await click('[aria-label="Undo"]', view);
    await until(() => Object.hasOwn(automatic(), autoId), 'undo confirmation');
    check(equal(feedback(), beforeAutomatic), 'undo confirmation restores exact saved feedback');
    autoRow().click();
    await delay(40);
    view.querySelector(`[data-autocull-photo-id="${CSS.escape(autoId)}"]`)?.click();
    const beforeCorrection = photoStore.photos.find((photo) => photo.id === autoId).flag;
    await press(beforeCorrection === 'pick' ? 'x' : 'p');
    await until(() => photoStore.photos.find((photo) => photo.id === autoId).flag !== beforeCorrection, 'human correction');
    check(!Object.hasOwn(automatic(), autoId), 'human correction releases automatic ownership');
    check(feedback().refinements.some((row) => row.photo_id === autoId), 'human correction replaces the automatic guess with eligible feedback');
    const correctedRun = await nativeSession(photoStore.photos, api.loadPairwisePreferences(), api.loadPreferenceRefinements(), fixture.folder, 'default', planApi.automaticPhotoIds(photoStore.photos, automatic()));
    check(correctedRun.stats.training_examples > 0 && correctedRun.ranker_version === 'xgboost-personal-ranker-v1', 'actual native retraining consumes the human correction');
    await click('[aria-label="Undo"]', view);
    await until(() => Object.hasOwn(automatic(), autoId), 'undo correction');
    check(equal(feedback(), beforeAutomatic), 'undo correction restores exact feedback atomically');
    const undoneRun = await nativeSession(photoStore.photos, api.loadPairwisePreferences(), api.loadPreferenceRefinements(), fixture.folder, 'default', planApi.automaticPhotoIds(photoStore.photos, automatic()));
    check(undoneRun.stats.training_examples === 0, 'native retraining forgets undone feedback and excludes restored automatic guesses');
    const stack = [...view.querySelectorAll('[data-stack-key]')].find((row) => row.getAttribute('data-stack-key').includes('native-smoke-original') && row.getAttribute('data-stack-key').includes('|'));
    check(Boolean(stack), 'synthetic burst forms a multi-frame native review stack');
    stack.click();
    await delay(50);
    await click('[data-autocull-photo-id="native-smoke-original"]', view);
    await press('p');
    await click('[data-autocull-photo-id="native-smoke-blurred"]', view);
    await press('x');
    await press('Enter');
    await until(() => feedback().pairs.length > 0, 'human stack comparison saved');
    const trained = feedback();
    check(trained.refinements.length > 0 && trained.pairs.length > 0, 'human stack decisions save absolute and relative feedback together');
    const current = photoStore.photos;
    const learned = await nativeSession(current, api.loadPairwisePreferences(), api.loadPreferenceRefinements(), fixture.folder, 'default', planApi.automaticPhotoIds(current, automatic()));
    check(learned.ranker_version === 'xgboost-personal-ranker-v1' && learned.stats.training_examples > 0, 'actual native training consumes saved human decisions and comparisons');
    check(equal(feedback(), trained), 'native retraining does not mutate saved feedback');
    const targets = photos.filter((photo) => ['native-smoke-original', 'native-smoke-blurred'].includes(photo.id)).map((photo) => ({
      ...photo, id: `shoot-b-${photo.id}`, file_path: `${fixture.other_folder}/${photo.file_name}`, flag: 'none', rating: 0,
    }));
    localStorage.setItem('hologram.native-smoke.targets', JSON.stringify({ photos: targets, feedback: trained, checks, elapsed_ms: performance.now() - started }));
    localStorage.setItem('hologram.native-smoke.phase', 'reload');
    location.reload();
  } catch (error) {
    const store = await import('/src/lib/stores/photoStore.ts').catch(() => null);
    await invoke('report_autocull_smoke', { result: {
      ok: false, checks,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      elapsed_ms: performance.now() - started, location: location.href,
      diagnostics: {
        automatic_key: automaticKey,
        automatic: automatic(), feedback: feedback(),
        decisions: store?.photoStore.photos.map((photo) => [photo.id, photo.flag, photo.rating]),
        status: [...document.querySelectorAll('[data-autocull-status]')].map((node) => node.textContent),
        overview: document.querySelector('[data-autocull-overview-state]')?.getAttribute('data-autocull-overview-state'),
        learner: document.querySelector('[data-autocull-session-learner]')?.outerHTML,
      },
    } });
  }
})();
