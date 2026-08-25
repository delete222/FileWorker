import Env from './Env';

export const FIXED_KEYS = {
    text: "jili-clip",
    file: "jili-file",
} as const;

export const isFixedKey = (filename: string) =>
    filename === FIXED_KEYS.text || filename === FIXED_KEYS.file;

export const hasGudingAccess = (env: Env, request: Request, filename?: string) => {
    if (filename && !isFixedKey(filename)) return false;
    return Boolean(env.JILI_TOKEN) && request.headers.get("x-jili-token") === env.JILI_TOKEN;
};
