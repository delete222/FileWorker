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

interface HistoryVersion {
  id: string;
  type: "text" | "file";
  filename: string;
  size: number | null;
  savedAt: string;
  archivedAt: string;
  preview: string;
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
const historyOpen = ref(false);
const historyType = ref<"text" | "file">("text");
const historyLoading = ref(false);
const historyVersions = ref<HistoryVersion[]>([]);
const historyBusyId = ref("");
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

const loadHistory = async (type: "text" | "file" = historyType.value) => {
  historyType.value = type;
  historyOpen.value = true;
  historyLoading.value = true;
  try {
    const response = await authorizedFetch(`/guding-api?type=${type}&t=${Date.now()}`);
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json() as { versions: HistoryVersion[] };
    historyVersions.value = result.versions;
  } catch (error) {
    console.error(error);
    historyVersions.value = [];
    setNotice("error", "历史版本读取失败");
  } finally {
    historyLoading.value = false;
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
    setNotice("success", "文字保存成功；上一版已自动进入历史记录");
    toast("文字保存成功", "success");
    if (historyOpen.value && historyType.value === "text") await loadHistory("text");
  } catch (error) {
    console.error(error);
    setNotice("error", "文字保存失败，请重试");
  } finally {
    textSaving.value = false;
  }
};

const clearText = async () => {
  if (!window.confirm("清空当前文字？清空前的内容会保留在历史版本中。")) return;
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
    setNotice("success", `文件“${file.name}”上传成功；上一版已自动归档`);
    toast("文件上传成功", "success");
    if (historyOpen.value && historyType.value === "file") await loadHistory("file");
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
  if (!window.confirm("删除当前文件？删除前会自动保留一个历史版本。")) return;
  try {
    const response = await authorizedFetch("/guding-api?type=file&current=1", { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    fileExists.value = false;
    latestFilename.value = "";
    fileSize.value = null;
    fileUpdatedAt.value = "";
    setNotice("success", "当前文件已删除，可从历史版本恢复");
    if (historyOpen.value && historyType.value === "file") await loadHistory("file");
  } catch (error) {
    console.error(error);
    setNotice("error", "删除文件失败");
  }
};

const restoreHistory = async (version: HistoryVersion) => {
  if (!window.confirm("恢复这个版本？当前版本会先自动归档。")) return;
  historyBusyId.value = version.id;
  try {
    const response = await authorizedFetch("/guding-api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: version.type, id: version.id }),
    });
    if (!response.ok) throw new Error(await response.text());
    if (version.type === "text") await loadLatestText();
    else await loadFileInfo();
    await loadHistory(version.type);
    setNotice("success", "历史版本已恢复，刚才的当前版本也已归档");
  } catch (error) {
    console.error(error);
    setNotice("error", "恢复历史版本失败");
  } finally {
    historyBusyId.value = "";
  }
};

const copyHistoryText = async (version: HistoryVersion) => {
  historyBusyId.value = version.id;
  try {
    const response = await authorizedFetch(`/guding-api?type=text&id=${encodeURIComponent(version.id)}`);
    if (!response.ok) throw new Error(await response.text());
    await navigator.clipboard.writeText(await response.text());
    setNotice("success", "历史文字已复制，不会改变当前版本");
  } catch (error) {
    console.error(error);
    setNotice("error", "复制历史文字失败");
  } finally {
    historyBusyId.value = "";
  }
};

const downloadHistoryFile = async (version: HistoryVersion) => {
  historyBusyId.value = version.id;
  try {
    const response = await authorizedFetch(`/guding-api?type=file&id=${encodeURIComponent(version.id)}`);
    if (!response.ok) throw new Error(await response.text());
    const filename = await saveBlob(response, "history-file");
    setNotice("success", `已开始下载历史文件“${filename}”`);
  } catch (error) {
    console.error(error);
    setNotice("error", "下载历史文件失败");
  } finally {
    historyBusyId.value = "";
  }
};

const deleteHistory = async (version: HistoryVersion) => {
  if (!window.confirm("永久删除这个历史版本？此操作不能撤销。")) return;
  historyBusyId.value = version.id;
  try {
    const response = await authorizedFetch(`/guding-api?type=${version.type}&id=${encodeURIComponent(version.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    historyVersions.value = historyVersions.value.filter((item) => item.id !== version.id);
    setNotice("success", "历史版本已删除");
  } catch (error) {
    console.error(error);
    setNotice("error", "删除历史版本失败");
  } finally {
    historyBusyId.value = "";
  }
};

const sharePrivateLink = async () => {
  const privateUrl = `${location.origin}${location.pathname}#/guding?token=${encodeURIComponent(token.value)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "固定传输", text: "固定传输私密入口", url: privateUrl });
      setNotice("success", "私密链接已打开系统分享面板");
    } else {
      await navigator.clipboard.writeText(privateUrl);
      setNotice("success", "完整私密链接已复制");
    }
  } catch (error) {
    if ((error as DOMException).name !== "AbortError") setNotice("error", "分享链接失败");
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
  if (historyOpen.value) loadHistory();
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
          <button class="secondary" @click="sharePrivateLink">分享入口</button>
          <button class="secondary" @click="loadHistory(historyType)">历史版本</button>
          <button v-if="installPrompt && !isStandalone" class="secondary" @click="installApp">安装应用</button>
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

      <section v-if="historyOpen" class="card history-card">
        <div class="history-header">
          <div><h2>历史版本</h2><p>文字保留最近 20 版，文件保留最近 5 版</p></div>
          <button class="icon-button" aria-label="关闭历史版本" @click="historyOpen = false">×</button>
        </div>
        <div class="history-tabs">
          <button :class="{ active: historyType === 'text' }" @click="loadHistory('text')">文字历史</button>
          <button :class="{ active: historyType === 'file' }" @click="loadHistory('file')">文件历史</button>
        </div>
        <p v-if="historyLoading" class="history-empty">正在读取历史版本…</p>
        <p v-else-if="!historyVersions.length" class="history-empty">还没有历史版本；下一次覆盖时会自动生成。</p>
        <div v-else class="history-list">
          <article v-for="version in historyVersions" :key="version.id" class="history-item">
            <div class="history-content">
              <strong v-if="version.type === 'file'">{{ version.filename ? decodeURIComponent(version.filename) : "历史文件" }}</strong>
              <strong v-else>{{ formatTime(version.savedAt) || "历史文字" }}</strong>
              <p v-if="version.type === 'file'">{{ version.size !== null ? formatBytes(version.size) : "" }} · {{ formatTime(version.savedAt) }}</p>
              <p v-else class="preview">{{ version.preview || "（空白内容）" }}</p>
            </div>
            <div class="history-actions">
              <button v-if="version.type === 'text'" class="secondary" @click="copyHistoryText(version)" :disabled="historyBusyId === version.id">复制</button>
              <button v-else class="secondary" @click="downloadHistoryFile(version)" :disabled="historyBusyId === version.id">下载</button>
              <button class="secondary" @click="restoreHistory(version)" :disabled="historyBusyId === version.id">恢复</button>
              <button class="text-danger" @click="deleteHistory(version)" :disabled="historyBusyId === version.id">删除</button>
            </div>
          </article>
        </div>
      </section>

      <section v-if="showInstallHelp" class="install-help">
        <template v-if="isIOS">iPhone 安装：Safari 分享按钮 → 添加到主屏幕</template>
        <template v-else>可通过浏览器菜单将“固定传输”安装为应用</template>
      </section>
      <p class="privacy">私密链接已保存在当前浏览器；不要转发给其他人。</p>
    </template>
  </main>
</template>

<style scoped>
.fixed-channel { width: min(900px, calc(100% - 32px)); margin: 24px auto; color: #24292f; }
.app-header, .heading-row, .header-actions, .title-row, .file-card, .actions, .file-actions, .inline-actions, .history-header, .history-actions, .progress-row { display: flex; align-items: center; gap: 10px; }
.app-header, .title-row, .file-card, .actions, .history-header { justify-content: space-between; }
.app-header { gap: 16px; margin: 0 2px 18px; }
.app-header h1 { font-size: 27px; }
.app-header p { margin-top: 4px; color: #57606a; font-size: 13px; }
.network-status { padding: 2px 7px; border-radius: 999px; font-size: 12px; }
.network-status.online { color: #116329; background: #dafbe1; }
.network-status.offline { color: #82071e; background: #ffebe9; }
.card { margin-bottom: 18px; padding: 20px; border: 1px solid #d0d7de; border-radius: 10px; background: white; box-shadow: 0 3px 12px rgb(140 149 159 / 15%); }
.card.dragging { border-color: #1f883d; background: #f0fff4; }
h1, h2, p { margin: 0; }
h2 { font-size: 19px; }
.title-row p, .file-info p, .privacy, .actions span, .empty-state p, .history-header p { margin-top: 5px; color: #57606a; font-size: 13px; }
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
.notice button, .icon-button { padding: 0 4px; color: inherit; background: transparent; font-size: 20px; }
.dirty { color: #9a6700 !important; font-weight: 600; }
.progress-row { margin-top: 12px; }
.progress-track { width: min(360px, 60vw); height: 7px; overflow: hidden; border-radius: 999px; background: #d8dee4; }
.progress-bar { height: 100%; background: #1f883d; transition: width .2s ease; }
.progress-row span { color: #57606a; font-size: 12px; }
.history-tabs { display: flex; gap: 8px; margin: 16px 0; border-bottom: 1px solid #d8dee4; }
.history-tabs button { border-radius: 6px 6px 0 0; background: transparent; }
.history-tabs button.active { color: #0969da; border-bottom: 2px solid #0969da; font-weight: 600; }
.history-empty { padding: 22px 0; color: #57606a; text-align: center; }
.history-list { display: flex; flex-direction: column; gap: 10px; }
.history-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid #d8dee4; border-radius: 8px; }
.history-content { min-width: 0; }
.history-content strong { display: block; overflow-wrap: anywhere; }
.history-content p { margin-top: 4px; color: #57606a; font-size: 12px; }
.history-content .preview { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: pre-wrap; }
.install-help { margin-bottom: 10px; padding: 10px 12px; border-radius: 7px; color: #57606a; background: #f6f8fa; text-align: center; font-size: 13px; }
.privacy, .empty-state { text-align: center; }
@media (max-width: 700px) {
  .app-header, .title-row, .file-card, .actions, .history-item { align-items: stretch; flex-direction: column; }
  .header-actions, .file-actions, .inline-actions, .history-actions { width: 100%; flex-wrap: wrap; }
  .header-actions button, .file-actions button, .inline-actions button, .history-actions button { flex: 1; }
}
</style>
