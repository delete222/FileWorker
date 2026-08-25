import { GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import mime from 'mime/lite';

import Env from './utils/Env';
import { createS3Client, auth } from './utils/utils';

const JILI_KEYS = new Set(["jili-clip", "jili-file"]);

const hasJiliAccess = (env: Env, request: Request, filename: string) => {
    if (!JILI_KEYS.has(filename) || !env.JILI_TOKEN) return false;
    return request.headers.get("x-jili-token") === env.JILI_TOKEN;
};

const canAccess = (env: Env, request: Request, filename: string) =>
    auth(env, request) || hasJiliAccess(env, request, filename);

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
    if (JILI_KEYS.has(filename)) headers.set('cache-control', 'no-store, max-age=0');
    return headers;
};

const fixedChannelAuthorized = (env: Env, request: Request, filename: string) =>
    !JILI_KEYS.has(filename) || canAccess(env, request, filename);

export const onRequestHead: PagesFunction<Env> = async ({ params, env, request }) => {
    const filename = params.filename as string;
    if (!fixedChannelAuthorized(env, request, filename)) {
        return new Response(null, { status: 404 });
    }

    try {
        const response = await createS3Client(env).send(
            new HeadObjectCommand({ Bucket: env.BUCKET, Key: filename })
        );
        const headers = buildObjectHeaders(filename, response);
        if (!JILI_KEYS.has(filename) &&
            headers.get("x-store-visibility") !== "public" &&
            !auth(env, request)) {
            return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200, headers });
    } catch {
        return new Response(null, { status: 404 });
    }
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { params, env, request } = context;
    const filename = params.filename as string;

    if (!fixedChannelAuthorized(env, request, filename)) {
        return new Response("Not found", { status: 404 });
    }

    const s3 = createS3Client(env);
    let response: GetObjectCommandOutput;
    try {
        response = await s3.send(new GetObjectCommand({ Bucket: env.BUCKET, Key: filename }));
    } catch {
        return new Response("Not found", { status: 404 });
    }

    const headers = buildObjectHeaders(filename, response);
    if (!JILI_KEYS.has(filename) &&
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

    const metadata: [string, string][] = [];
    for (const [key, value] of request.headers.entries()) {
        if (key.startsWith('x-store-')) metadata.push([key, value]);
    }
    if (JILI_KEYS.has(filename)) {
        const visibility = metadata.findIndex(([key]) => key === 'x-store-visibility');
        if (visibility >= 0) metadata[visibility] = ['x-store-visibility', 'private'];
        else metadata.push(['x-store-visibility', 'private']);
    }

    const upload = new Upload({
        client: createS3Client(env),
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
    return new Response("OK", { status: 200 });
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
    const { params, env, request } = context;
    const filename = params.filename as string;
    if (!auth(env, request)) return new Response("Unauthorized", { status: 401 });

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
