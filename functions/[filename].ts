import { GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import mime from 'mime/lite';

import Env from './utils/Env';
import { createS3Client, auth } from './utils/utils';
import { hasGudingAccess, isFixedKey } from './utils/guding';

const canAccess = (env: Env, request: Request, filename: string) =>
    auth(env, request) || hasGudingAccess(env, request, filename);

interface ObjectHeadersSource {
    Metadata?: Record<string, string>,
    ContentType?: string,
    ContentLength?: number,
    LastModified?: Date,
    ETag?: string,
}

const buildObjectHeaders = (filename: string, response: ObjectHeadersSource) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.Metadata ?? {})) {
        if (value) headers.set(key, value);
    }

    if (response.Metadata?.['x-store-type'] === "text") {
        headers.set('content-type', 'text/plain;charset=utf-8');
    } else {
        headers.set(
            'content-type',
            response.ContentType || mime.getType(filename) || "application/octet-stream"
        );
    }
    if (response.Metadata?.['x-store-filename']) {
        headers.set('x-store-filename', response.Metadata['x-store-filename']);
    }
    if (response.ContentLength !== undefined) headers.set('content-length', response.ContentLength.toString());
    if (response.LastModified) headers.set('last-modified', response.LastModified.toUTCString());
    if (response.ETag) headers.set('etag', response.ETag);
    if (isFixedKey(filename)) headers.set('cache-control', 'no-store, max-age=0');
    return headers;
};

const fixedChannelAuthorized = (env: Env, request: Request, filename: string) =>
    !isFixedKey(filename) || canAccess(env, request, filename);

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { params, env, request } = context;
    const filename = params.filename as string;

    if (!fixedChannelAuthorized(env, request, filename)) {
        return new Response("Not found", { status: 404 });
    }

    // Return lightweight file metadata as JSON. A dedicated response avoids
    // HEAD/body and Content-Length inconsistencies in Cloudflare Pages.
    const url = new URL(request.url);
    if (filename === "jili-file" && url.searchParams.get("metadata") === "1") {
        try {
            const response = await createS3Client(env).send(
                new HeadObjectCommand({ Bucket: env.BUCKET, Key: filename })
            );
            return Response.json({
                filename: response.Metadata?.['x-store-filename'] ?? "",
                size: response.ContentLength ?? null,
                lastModified: response.LastModified?.toISOString() ?? "",
            }, {
                headers: { 'cache-control': 'no-store, max-age=0' },
            });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    }

    const s3 = createS3Client(env);
    let response: GetObjectCommandOutput;
    try {
        response = await s3.send(new GetObjectCommand({ Bucket: env.BUCKET, Key: filename }));
    } catch {
        return new Response("Not found", { status: 404 });
    }

    const headers = buildObjectHeaders(filename, response);
    if (!isFixedKey(filename) &&
        headers.get("x-store-visibility") !== "public" &&
        !auth(env, request)) {
        return new Response("Not found", { status: 404 });
    }

    return new Response(response.Body?.transformToWebStream(), { headers });
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
    const { params, env, request } = context;
    const filename = params.filename as string;
    if (!canAccess(env, request, filename)) {
        return new Response("Unauthorized", { status: 401 });
    }

    const s3 = createS3Client(env);
    const fixedKey = isFixedKey(filename);

    const metadata: [string, string][] = [];
    for (const [key, value] of request.headers.entries()) {
        if (key.startsWith('x-store-')) metadata.push([key, value]);
    }
    if (fixedKey) {
        const visibility = metadata.findIndex(([key]) => key === 'x-store-visibility');
        if (visibility >= 0) metadata[visibility] = ['x-store-visibility', 'private'];
        else metadata.push(['x-store-visibility', 'private']);
        const savedAt = metadata.findIndex(([key]) => key === 'x-store-saved-at');
        const savedAtValue: [string, string] = ['x-store-saved-at', new Date().toISOString()];
        if (savedAt >= 0) metadata[savedAt] = savedAtValue;
        else metadata.push(savedAtValue);
    }

    const upload = new Upload({
        client: s3,
        params: {
            Bucket: env.BUCKET,
            Key: filename,
            Body: request.body,
            ContentType: request.headers.get('content-type') ?? 'application/octet-stream',
            Metadata: Object.fromEntries(metadata),
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5,
        leavePartsOnError: false,
    });
    await upload.done();
    return Response.json({ ok: true }, { status: 200 });
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
    const { params, env, request } = context;
    const filename = params.filename as string;
    if (!canAccess(env, request, filename)) return new Response("Unauthorized", { status: 401 });

    const metadata: [string, string][] = [];
    for (const [key, value] of request.headers.entries()) {
        if (key.startsWith('x-store-')) metadata.push([key, value]);
    }
    await createS3Client(env).send(new CopyObjectCommand({
        Bucket: env.BUCKET,
        CopySource: `${env.BUCKET}/${filename}`,
        Key: filename,
        MetadataDirective: "REPLACE",
        Metadata: Object.fromEntries(metadata),
    }));
    return new Response("OK", { status: 200 });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
    const { params, env, request } = context;
    const filename = params.filename as string;
    if (!auth(env, request)) return new Response("Unauthorized", { status: 401 });

    const command = new DeleteObjectCommand({ Bucket: env.BUCKET, Key: filename });
    const url = await getSignedUrl(createS3Client(env), command, { expiresIn: 3600 });
    await fetch(url, { method: 'DELETE' });
    return new Response("OK", { status: 200 });
}

export const onRequest: PagesFunction<Env> = async () =>
    new Response("Method not allowed", { status: 405 });
