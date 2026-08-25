<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { PutFile } from "@/api";
import { formatBytes } from "@/utils/utils";
import { toast } from "@/utils/toast";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const CLIP_KEY = "jili-clip";
const FILE_KEY = "jili-file";
const TOKEN_STORAGE_KEY = "jili-channel-token";

const route = useRoute();
const queryToken = typeof route.query.token === "string" ? route.query.token : "";
if (queryToken) localStorage.setItem(TOKEN_STORAGE_KEY, queryToken);

const token = ref(queryToken || localStorage.getItem(TOKEN_STORAGE_KEY) || "");
const ready = computed(() => token.value.length > 0);
const online = ref(navigator.onLine);
const text = ref("");
const textDirty = ref(false);
const textLoading = ref(false);
const textSaving = ref(false);
const textUpdatedAt = ref("");
const fileUploading = ref(false);
const uploadProgress = ref(0);
const fileExists = ref<boolean | null>(null);
const latestFilename = ref("");
const fileSize = ref<number | null>(null);
const fileUpdatedAt = ref("");
const fileInput = ref<HTMLInputElement>();
const dragging = ref(false);
const notice = ref<{ type: "success" | "error" | "info"; message: string } | null>(null);
const menuOpen = ref(false);
const installPrompt = ref<InstallPromptEvent | null>(
  (window.__pwaInstallPrompt as InstallPromptEvent | undefined) ?? null
);

const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const showInstallHelp = computed(() => !isStandalone && !installPrompt.value);

const setNotice = (type: "success" | "error" | "info", message: string) => {
  notice.value = { type, message };
};

const formatTime = (value: string | null) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
};

const authorizedFetch = (path: string, init: RequestInit = {}) => fetch(path, {
  ...init,
  cache: "no-store",
  headers: { ...init.headers, "x-jili-token": token.value },
});

const loadLatestText = async (showResult = false) => {
  if (!ready.value) return;
  textLoading.value = true;
  try {
    const response = await authorizedFetch(`/${CLIP_KEY}?t=${Date.now()}`);
    if (response.ok) {
      text.value = await response.text();
      textDirty.value = false;
      textUpdatedAt.value = formatTime(response.headers.get("last-modified"));
      if (showResult) setNotice("success", "已读取最新文字");
    } else if (response.status === 404) {
      text.value = "";
      textDirty.value = false;
      textUpdatedAt.value = "";
      if (showResult) setNotice("info", "目前还没有保存文字");
    } else throw new Error(await response.text());
  } catch (error) {
    console.error(error);
    setNotice("error", "读取失败，请检查网络或私密链接");
  } finally {
    textLoading.value = false;
  }
};

const loadFileInfo = async () => {
  if (!ready.value) return;
  try {
    const response = await authorizedFetch(`/${FILE_KEY}?metadata=1&t=${Date.now()}`);
    if (response.status === 404) {
      fileExists.value = false;
      latestFilename.value = "";
      fileSize.value = null;
      fileUpdatedAt.value = "";
      return;
    }
    if (!response.ok) throw new Error(await response.text());
    const metadata = await response.json() as { filename: string; size: number | null; lastModified: string };
    fileExists.value = true;
    latestFilename.value = metadata.filename ? decodeURIComponent(metadata.filename) : "latest-file";
    fileSize.value = metadata.size;
    fileUpdatedAt.value = formatTime(metadata.lastModified);
  } catch (error) {
    console.error(error);
    fileExists.value = null;
  }
};

const saveText = async () => {
  if (!ready.value) return;
  textSaving.value = true;
  notice.value = null;
  try {
    await PutFile(CLIP_KEY, text.value, "private", "text", { jiliToken: token.value });
    textDirty.value = false;
    textUpdatedAt.value = formatTime(new Date().toISOString());
    setNotice("success", "文字保存成功");
    toast("文字保存成功", "success");
  } catch (error) {
    console.error(error);
    setNotice("error", "文字保存失败，请重试");
  } finally {
    textSaving.value = false;
  }
};

const clearText = async () => {
  if (!window.confirm("清空当前文字？此操作会覆盖现有内容。")) return;
  text.value = "";
  textDirty.value = true;
  await saveText();
};

const copyText = async () => {
  try {
    await navigator.clipboard.writeText(text.value);
    setNotice("success", "文字已复制到剪贴板");
  } catch {
    setNotice("error", "复制失败，请手动选择文字");
  }
};

const uploadFile = async (file: File) => {
  fileUploading.value = true;
  uploadProgress.value = 0;
  notice.value = null;
  try {
    await PutFile(FILE_KEY, file, "private", "file", {
      originalFilename: file.name,
      jiliToken: token.value,
      onProgress: (percent) => uploadProgress.value = percent,
    });
    latestFilename.value = file.name;
    fileSize.value = file.size;
    fileUpdatedAt.value = formatTime(new Date().toISOString());
    fileExists.value = true;
    setNotice("success", `文件“${file.name}”上传成功`);
    toast("文件上传成功", "success");
  } catch (error) {
    console.error(error);
    setNotice("error", "文件上传失败，请重试");
  } finally {
    fileUploading.value = false;
    uploadProgress.value = 0;
  }
};

const onFileSelected = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) await uploadFile(file);
  target.value = "";
};

const onDrop = async (event: DragEvent) => {
  event.preventDefault();
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) await uploadFile(file);
};

const saveBlob = async (response: Response, fallbackName: string) => {
  const encodedName = response.headers.get("x-store-filename");
  const filename = encodedName ? decodeURIComponent(encodedName) : fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
};

const downloadLatestFile = async () => {
  try {
    setNotice("info", "正在准备下载最新文件…");
    const response = await authorizedFetch(`/${FILE_KEY}?t=${Date.now()}`);
    if (!response.ok) throw new Error(await response.text());
    const filename = await saveBlob(response, "latest-file");
    setNotice("success", `已开始下载“${filename}”`);
  } catch (error) {
    console.error(error);
    setNotice("error", "暂无文件或私密链接无效");
  }
};

const deleteCurrentFile = async () => {
  if (!window.confirm("删除当前文件？此操作不能撤销。")) return;
  try {
    const response = await authorizedFetch(`/${FILE_KEY}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    fileExists.value = false;
    latestFilename.value = "";
    fileSize.value = null;
    fileUpdatedAt.value = "";
    setNotice("success", "当前文件已删除");
  } catch (error) {
    console.error(error);
    setNotice("error", "删除文件失败");
  }
};

const copyPrivateLink = async () => {
  const privateUrl = `${location.origin}${location.pathname}#/guding?token=${encodeURIComponent(token.value)}`;
  try {
    await navigator.clipboard.writeText(privateUrl);
    menuOpen.value = false;
    setNotice("success", "纯网址已复制，不包含附加文字");
  } catch {
    setNotice("error", "复制私密入口失败");
  }
};

const saveShortcut = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveText();
  }
};

const onVisibilityChange = () => {
  if (document.visibilityState !== "visible") return;
  if (!textDirty.value) loadLatestText();
  loadFileInfo();
};

const onInstallAvailable = () => {
  installPrompt.value = (window.__pwaInstallPrompt as InstallPromptEvent | undefined) ?? null;
};

const installApp = async () => {
  if (!installPrompt.value) return;
  await installPrompt.value.prompt();
  const result = await installPrompt.value.userChoice;
  if (result.outcome === "accepted") setNotice("success", "固定传输已安装");
  installPrompt.value = null;
  window.__pwaInstallPrompt = undefined;
};

const setOnline = () => online.value = true;
const setOffline = () => online.value = false;

onMounted(() => {
  loadLatestText();
  loadFileInfo();
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pwa-install-available", onInstallAvailable);
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOffline);
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pwa-install-available", onInstallAvailable);
  window.removeEventListener("online", setOnline);
  window.removeEventListener("offline", setOffline);
});
</script>

<template>
  <main class="fixed-channel" @keydown="saveShortcut">
    <section v-if="!ready" class="card empty-state">
      <h1>链接无效</h1>
      <p>请使用包含 token 的完整私密链接打开此页面。</p>
    </section>

    <template v-else>
      <header class="app-header">
        <div>
          <div class="heading-row">
            <h1>固定传输</h1>
            <span class="network-status" :class="online ? 'online' : 'offline'">{{ online ? "在线" : "离线" }}</span>
          </div>
          <p>手机与电脑之间快速传递文字和文件</p>
        </div>
        <div class="header-actions">
          <button v-if="installPrompt && !isStandalone" class="secondary" @click="installApp">安装应用</button>
          <div class="more-menu">
            <button class="secondary" @click="menuOpen = !menuOpen">更多</button>
            <div v-if="menuOpen" class="menu-panel">
              <button @click="copyPrivateLink">复制私密入口</button>
            </div>
          </div>
        </div>
      </header>

      <div v-if="notice" class="notice" :class="notice.type" role="status" aria-live="polite">
        <span>{{ notice.message }}</span>
        <button aria-label="关闭提示" @click="notice = null">×</button>
      </div>

      <section class="card">
        <div class="title-row">
          <div>
            <h2>文字</h2>
            <p>{{ textUpdatedAt ? `最后更新：${textUpdatedAt}` : "尚未保存" }}</p>
          </div>
          <div class="inline-actions">
            <button class="secondary" @click="copyText" :disabled="!text">复制</button>
            <button class="secondary" @click="loadLatestText(true)" :disabled="textLoading">刷新</button>
            <button class="text-danger" @click="clearText" :disabled="textSaving || !text">清空</button>
          </div>
        </div>
        <textarea v-model="text" :disabled="textLoading" placeholder="在这里粘贴文字" autofocus @input="textDirty = true"></textarea>
        <div class="actions">
          <span :class="{ dirty: textDirty }">{{ textDirty ? "有尚未保存的修改" : "Ctrl / ⌘ + S 快速保存" }}</span>
          <button class="primary" @click="saveText" :disabled="textSaving || textLoading || !online">{{ textSaving ? "保存中…" : "保存文字" }}</button>
        </div>
      </section>

      <section class="card file-card" :class="{ dragging }" @dragenter.prevent="dragging = true" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop="onDrop">
        <div class="file-info">
          <h2>文件</h2>
          <p v-if="fileExists === true" class="filename">{{ latestFilename }}</p>
          <p v-if="fileExists === true">
            {{ fileSize !== null ? formatBytes(fileSize) : "" }}<span v-if="fileUpdatedAt"> · 最后更新：{{ fileUpdatedAt }}</span>
          </p>
          <p v-else-if="fileExists === false">尚未上传；也可以把文件拖到这里</p>
          <p v-else>文件状态读取失败，仍可尝试下载</p>
          <div v-if="fileUploading" class="progress-row">
            <div class="progress-track"><div class="progress-bar" :style="{ width: `${uploadProgress}%` }"></div></div>
            <span>{{ uploadProgress }}%</span>
          </div>
        </div>
        <input ref="fileInput" type="file" class="hidden" @change="onFileSelected" />
        <div class="file-actions">
          <button class="secondary" @click="fileInput?.click()" :disabled="fileUploading || !online">{{ fileUploading ? `上传中 ${uploadProgress}%` : "上传新文件" }}</button>
          <button class="primary" @click="downloadLatestFile" :disabled="fileExists === false || !online">下载最新文件</button>
          <button v-if="fileExists === true" class="text-danger" @click="deleteCurrentFile">删除</button>
        </div>
      </section>

      <section v-if="showInstallHelp" class="install-help">
        <template v-if="isIOS">iPhone 安装：Safari 分享按钮 → 添加到主屏幕</template>
        <template v-else>可通过浏览器菜单将“固定传输”安装为应用</template>
      </section>
      <p class="privacy">仅保留最新文字和最新文件；覆盖或删除后不可恢复。私密链接请勿转发。</p>
    </template>
  </main>
</template>

<style scoped>
.fixed-channel { width: min(900px, calc(100% - 32px)); margin: 24px auto; color: #24292f; }
.app-header, .heading-row, .header-actions, .title-row, .file-card, .actions, .file-actions, .inline-actions, .progress-row { display: flex; align-items: center; gap: 10px; }
.app-header, .title-row, .file-card, .actions { justify-content: space-between; }
.app-header { gap: 16px; margin: 0 2px 18px; }
.app-header h1 { font-size: 27px; }
.app-header p { margin-top: 4px; color: #57606a; font-size: 13px; }
.network-status { padding: 2px 7px; border-radius: 999px; font-size: 12px; }
.network-status.online { color: #116329; background: #dafbe1; }
.network-status.offline { color: #82071e; background: #ffebe9; }
.more-menu { position: relative; }
.menu-panel { position: absolute; z-index: 10; top: calc(100% + 6px); right: 0; min-width: 150px; padding: 6px; border: 1px solid #d0d7de; border-radius: 8px; background: white; box-shadow: 0 8px 24px rgb(140 149 159 / 25%); }
.menu-panel button { width: 100%; text-align: left; background: transparent; }
.menu-panel button:hover { background: #f6f8fa; }
.card { margin-bottom: 18px; padding: 20px; border: 1px solid #d0d7de; border-radius: 10px; background: white; box-shadow: 0 3px 12px rgb(140 149 159 / 15%); }
.card.dragging { border-color: #1f883d; background: #f0fff4; }
h1, h2, p { margin: 0; }
h2 { font-size: 19px; }
.title-row p, .file-info p, .privacy, .actions span, .empty-state p { margin-top: 5px; color: #57606a; font-size: 13px; }
.filename { color: #24292f !important; font-weight: 600; overflow-wrap: anywhere; }
textarea { box-sizing: border-box; width: 100%; min-height: 280px; margin: 18px 0 12px; padding: 14px; resize: vertical; border: 1px solid #d0d7de; border-radius: 7px; outline-color: #0969da; font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
button { padding: 8px 14px; border: 1px solid transparent; border-radius: 6px; cursor: pointer; white-space: nowrap; }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary { color: white; background: #1f883d; }
.secondary { border-color: #d0d7de; background: #f6f8fa; }
.text-danger { color: #cf222e; background: transparent; }
.text-danger:hover { background: #ffebe9; }
.hidden { display: none; }
.notice { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; padding: 12px 14px; border-radius: 8px; font-size: 14px; }
.notice.success { color: #116329; background: #dafbe1; border: 1px solid #82e596; }
.notice.error { color: #82071e; background: #ffebe9; border: 1px solid #ff8182; }
.notice.info { color: #0550ae; background: #ddf4ff; border: 1px solid #80ccff; }
.notice button { padding: 0 4px; color: inherit; background: transparent; font-size: 20px; }
.dirty { color: #9a6700 !important; font-weight: 600; }
.progress-row { margin-top: 12px; }
.progress-track { width: min(360px, 60vw); height: 7px; overflow: hidden; border-radius: 999px; background: #d8dee4; }
.progress-bar { height: 100%; background: #1f883d; transition: width .2s ease; }
.progress-row span { color: #57606a; font-size: 12px; }
.install-help { margin-bottom: 10px; padding: 10px 12px; border-radius: 7px; color: #57606a; background: #f6f8fa; text-align: center; font-size: 13px; }
.privacy, .empty-state { text-align: center; }
@media (max-width: 700px) {
  .app-header, .title-row, .file-card, .actions { align-items: stretch; flex-direction: column; }
  .header-actions, .file-actions, .inline-actions { width: 100%; flex-wrap: wrap; }
  .header-actions button, .file-actions button, .inline-actions button { flex: 1; }
}
</style>
