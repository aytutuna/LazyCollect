const regions = { na: { db: "DB_NA", bucket: "FILES_NA" } } as const;

export type Region = keyof typeof regions;

export function isRegion(id: string): id is Region {
  return Object.hasOwn(regions, id);
}

export function regionOf(env: Env, id: Region): { db: D1Database; bucket: R2Bucket } {
  const r = regions[id];
  return { db: env[r.db], bucket: env[r.bucket] };
}
