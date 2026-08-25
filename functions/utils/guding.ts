import {
    CopyObjectCommand,
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
} from "@aws-sdk/client-s3";

import Env from './Env';

export type GudingType = "text" | "file";

export const FIXED_KEYS: Record<GudingType, string> = {
    text: "jili-clip",
    file: "jili-file",
};

export const HISTORY_LIMITS: Record<GudingType, number> = {
    text: 20,
    file: 5,
};

export const isFixedKey = (filename: string) => Object.values(FIXED_KEYS).includes(filename);

export const getGudingType = (filename: string): GudingType | null => {
    if (filename === FIXED_KEYS.text) return "text";
    if (filename === FIXED_KEYS.file) return "file";
    return null;
};

export const hasGudingAccess = (env: Env, request: Request, filename?: string) => {
    if (filename && !isFixedKey(filename)) return false;
    return Boolean(env.JILI_TOKEN) && request.headers.get("x-jili-token") === env.JILI_TOKEN;
};

export const historyPrefix = (type: GudingType) => `guding-history/${type}/`;

export const historyKey = (type: GudingType, id: string) => `${historyPrefix(type)}${id}`;

export const validHistoryId = (id: string) => /^\d{13}-[0-9a-f]{8}$/.test(id);

export const copySource = (bucket: string, key: string) =>
    `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

export const trimHistory = async (s3: S3Client, env: Env, type: GudingType) => {
    const listed = await s3.send(new ListObjectsV2Command({
        Bucket: env.BUCKET,
        Prefix: historyPrefix(type),
    }));
    const stale = [...(listed.Contents ?? [])]
        .filter((item) => item.Key)
        .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
        .slice(HISTORY_LIMITS[type]);

    if (stale.length) {
        await s3.send(new DeleteObjectsCommand({
            Bucket: env.BUCKET,
            Delete: { Objects: stale.map((item) => ({ Key: item.Key! })) },
        }));
    }
};

export const archiveCurrent = async (s3: S3Client, env: Env, type: GudingType, trim = true) => {
    const currentKey = FIXED_KEYS[type];
    let head;
    try {
        head = await s3.send(new HeadObjectCommand({ Bucket: env.BUCKET, Key: currentKey }));
    } catch (error: any) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null;
        throw error;
    }

    const id = head.Metadata?.['x-store-version-id'] ?? `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await s3.send(new CopyObjectCommand({
        Bucket: env.BUCKET,
        CopySource: copySource(env.BUCKET, currentKey),
        Key: historyKey(type, id),
        MetadataDirective: "COPY",
    }));
    if (trim) await trimHistory(s3, env, type);
    return id;
};
