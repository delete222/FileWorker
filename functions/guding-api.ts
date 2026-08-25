import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";

import Env from './utils/Env';
import { createS3Client } from './utils/utils';
import {
    FIXED_KEYS,
    GudingType,
    archiveCurrent,
    copySource,
    hasGudingAccess,
    historyKey,
    historyPrefix,
    trimHistory,
    validHistoryId,
} from './utils/guding';

const noStoreHeaders = { 'cache-control': 'no-store, max-age=0' };

const getType = (url: URL): GudingType | null => {
    const type = url.searchParams.get('type');
    return type === 'text' || type === 'file' ? type : null;
};

const unauthorized = () => new Response("Not found", { status: 404 });

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
    if (!hasGudingAccess(env, request)) return unauthorized();
    const url = new URL(request.url);
    const type = getType(url);
    if (!type) return new Response("Invalid type", { status: 400 });

    const s3 = createS3Client(env);
    const id = url.searchParams.get('id');
    if (id) {
        if (!validHistoryId(id)) return new Response("Invalid id", { status: 400 });
        try {
            const object = await s3.send(new GetObjectCommand({
                Bucket: env.BUCKET,
                Key: historyKey(type, id),
            }));
            const headers = new Headers(noStoreHeaders);
            const encodedName = object.Metadata?.['x-store-filename'];
            if (type === 'text') {
                headers.set('content-type', 'text/plain;charset=utf-8');
            } else {
                headers.set('content-type', object.ContentType ?? 'application/octet-stream');
                if (encodedName) headers.set('x-store-filename', encodedName);
            }
            return new Response(object.Body?.transformToWebStream(), { headers });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    }

    const listed = await s3.send(new ListObjectsV2Command({
        Bucket: env.BUCKET,
        Prefix: historyPrefix(type),
    }));
    const objects = [...(listed.Contents ?? [])]
        .filter((item) => item.Key)
        .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

    let currentVersionId = "";
    try {
        const current = await s3.send(new HeadObjectCommand({ Bucket: env.BUCKET, Key: FIXED_KEYS[type] }));
        currentVersionId = current.Metadata?.['x-store-version-id'] ?? "";
    } catch {
        // There may be no current object after a user intentionally deletes it.
    }

    const versions = await Promise.all(objects.map(async (item) => {
        const id = item.Key!.slice(historyPrefix(type).length);
        const head = await s3.send(new HeadObjectCommand({ Bucket: env.BUCKET, Key: item.Key! }));
        let preview = "";
        if (type === 'text') {
            const object = await s3.send(new GetObjectCommand({ Bucket: env.BUCKET, Key: item.Key! }));
            preview = (await object.Body?.transformToString() ?? "").slice(0, 160);
        }
        return {
            id,
            type,
            filename: head.Metadata?.['x-store-filename'] ?? "",
            size: item.Size ?? null,
            savedAt: head.Metadata?.['x-store-saved-at'] ?? item.LastModified?.toISOString() ?? "",
            archivedAt: item.LastModified?.toISOString() ?? "",
            preview,
            isCurrent: Boolean(currentVersionId) && id === currentVersionId,
        };
    }));

    return Response.json({ versions }, { headers: noStoreHeaders });
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
    if (!hasGudingAccess(env, request)) return unauthorized();
    const payload = await request.json<{ type?: GudingType, id?: string }>();
    const { type, id } = payload;
    if ((type !== 'text' && type !== 'file') || !id || !validHistoryId(id)) {
        return new Response("Invalid request", { status: 400 });
    }

    const s3 = createS3Client(env);
    try {
        await s3.send(new HeadObjectCommand({ Bucket: env.BUCKET, Key: historyKey(type, id) }));
        await archiveCurrent(s3, env, type, false);
        await s3.send(new CopyObjectCommand({
            Bucket: env.BUCKET,
            CopySource: copySource(env.BUCKET, historyKey(type, id)),
            Key: FIXED_KEYS[type],
            MetadataDirective: "COPY",
        }));
        await trimHistory(s3, env, type);
        return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch {
        return new Response("Not found", { status: 404 });
    }
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request }) => {
    if (!hasGudingAccess(env, request)) return unauthorized();
    const url = new URL(request.url);
    const type = getType(url);
    if (!type) return new Response("Invalid type", { status: 400 });

    const s3 = createS3Client(env);
    if (url.searchParams.get('current') === '1') {
        await archiveCurrent(s3, env, type);
        await s3.send(new DeleteObjectCommand({ Bucket: env.BUCKET, Key: FIXED_KEYS[type] }));
        return Response.json({ ok: true }, { headers: noStoreHeaders });
    }

    const id = url.searchParams.get('id');
    if (!id || !validHistoryId(id)) return new Response("Invalid id", { status: 400 });
    await s3.send(new DeleteObjectCommand({ Bucket: env.BUCKET, Key: historyKey(type, id) }));
    return Response.json({ ok: true }, { headers: noStoreHeaders });
};

export const onRequest: PagesFunction<Env> = async () =>
    new Response("Method not allowed", { status: 405 });
