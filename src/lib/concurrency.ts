type NavigatorWithDeviceMemory = Navigator & {
  deviceMemory?: number;
};

function hardwareProfile(): { logicalCpus: number; memoryGb?: number } {
  if (typeof navigator === "undefined") return { logicalCpus: 2 };
  const logicalCpus = Math.max(1, navigator.hardwareConcurrency || 2);
  const memoryGb = (navigator as NavigatorWithDeviceMemory).deviceMemory;
  return {
    logicalCpus,
    memoryGb: memoryGb && memoryGb > 0 ? memoryGb : undefined,
  };
}

/** CPU- and memory-heavy work such as image decoding and ML inference. */
export function heavyMediaConcurrency(): number {
  const { logicalCpus, memoryGb } = hardwareProfile();
  const cpuSlots = Math.max(1, Math.floor(logicalCpus / 2));
  const memorySlots = memoryGb === undefined ? cpuSlots : Math.max(1, Math.floor(memoryGb));
  return Math.min(cpuSlots, memorySlots);
}

/** Mixed image and metadata work that spends meaningful time waiting on I/O. */
export function mediaIndexConcurrency(): number {
  const { logicalCpus, memoryGb } = hardwareProfile();
  const cpuSlots = Math.max(1, logicalCpus - 1);
  const memorySlots = memoryGb === undefined ? cpuSlots : Math.max(1, Math.floor(memoryGb * 2));
  return Math.min(cpuSlots, memorySlots);
}
