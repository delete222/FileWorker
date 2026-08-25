<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { PutFile } from "@/api";
import { toast } from "@/utils/toast";

const CLIP_KEY = "jili-clip";
const FILE_KEY = "jili-file";
const TOKEN_STORAGE_KEY = "jili-channel-token";

const route = useRoute();
const queryToken = typeof route.query.token === "string" ? route.query.token : "";
if (queryToken) localStorage.setItem(TOKEN_STORAGE_KEY, queryToken);

const token = ref(queryToken || localStorage.getItem(TOKEN_STORAGE_KEY) || "");
const ready = computed(() => token.value.length > 0);
const text = ref("");
const textLoading = ref(false);
const textSaving = ref(false);
const fileUploading = ref(false);
const fileInput = ref<HTMLInputElement>();

const authorizedFetch = (path: string) => fetch(path, {
  cache: "no-store",
  headers: { "x-jili-token": token.value },
});

const loadLatestText = async () => {
  if (!ready.value) return;
  textLoading.value = true;
  try {
    const response = await authorizedFetch(`/${CLIP_KEY}?t=${Date.now()}`);
    if (response.ok) text.value = await response.text();
    else if (response.status !== 404) throw new Error(await response.text());
  } catch (error) {
    console.error(error);
    toast("读取失败，请检查私密链接", "error");
  } finally {
    textLoading.value = false;
  }
};

const saveText = async () => {
  if (!ready.value) return;
  textSaving.value = true;
  try {
    await PutFile(CLIP_KEY, text.value, "private", "text", { jiliToken: token.value });
    toast("文字已保存", "success");
  } finally {
    textSaving.value = false;
  }
};

const uploadFile = async (file: File) => {
  fileUploading.value = true;
  try {
    await PutFile(FILE_KEY, file, "private", "file", {
      originalFilename: file.name,
      jiliToken: token.value,
    });
    toast("文件已更新", "success");
  } finally {
    fileUploading.value = false;
  }
};

const onFileSelected = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) await uploadFile(file);
  target.value = "";
};

const downloadLatestFile = async () => {
  try {
    const response = await authorizedFetch(`/${FILE_KEY}?t=${Date.now()}`);
    if (!response.ok) throw new Error(await response.text());
    const encodedName = response.headers.get("x-store-filename");
    const filename = encodedName ? decodeURIComponent(encodedName) : "latest-file";
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
    toast("暂无文件或链接无效", "error");
  }
};

const saveShortcut = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveText();
  }
};

onMounted(loadLatestText);
</script>

<template>
  <main class="fixed-channel" @keydown="saveShortcut">
    <section v-if="!ready" class="card empty-state">
      <h1>链接无效</h1>
      <p>请使用包含 token 的完整私密链接打开此页面。</p>
    </section>

    <template v-else>
      <section class="card">
        <div class="title-row">
          <div>
            <h1>JILI 固定传输</h1>
            <p>刷新后读取另一台设备最后保存的文字</p>
          </div>
          <button class="secondary" @click="loadLatestText" :disabled="textLoading">
            {{ textLoading ? "读取中…" : "刷新文字" }}
          </button>
        </div>
        <textarea
          v-model="text"
          :disabled="textLoading"
          placeholder="在这里粘贴文字"
          autofocus
        ></textarea>
        <div class="actions">
          <span>Ctrl / ⌘ + S 快速保存</span>
          <button class="primary" @click="saveText" :disabled="textSaving || textLoading">
            {{ textSaving ? "保存中…" : "保存文字" }}
          </button>
        </div>
      </section>

      <section class="card file-card">
        <div>
          <h2>固定文件槽位</h2>
          <p>新文件会覆盖旧文件，下载按钮始终获取最新版</p>
        </div>
        <input ref="fileInput" type="file" class="hidden" @change="onFileSelected" />
        <div class="file-actions">
          <button class="secondary" @click="fileInput?.click()" :disabled="fileUploading">
            {{ fileUploading ? "上传中…" : "上传新文件" }}
          </button>
          <button class="primary" @click="downloadLatestFile">下载最新文件</button>
        </div>
      </section>
      <p class="privacy">私密链接已在本浏览器保存；不要转发给其他人。</p>
    </template>
  </main>
</template>

<style scoped>
.fixed-channel { width: min(820px, calc(100% - 32px)); margin: 24px auto; color: #24292f; }
.card { margin-bottom: 18px; padding: 20px; border: 1px solid #d0d7de; border-radius: 10px; background: white; box-shadow: 0 3px 12px rgb(140 149 159 / 15%); }
.title-row, .file-card, .actions, .file-actions { display: flex; align-items: center; gap: 12px; }
.title-row, .file-card, .actions { justify-content: space-between; }
h1, h2, p { margin: 0; }
h1 { font-size: 24px; }
h2 { font-size: 19px; }
.title-row p, .file-card p, .privacy, .actions span, .empty-state p { margin-top: 5px; color: #57606a; font-size: 13px; }
textarea { box-sizing: border-box; width: 100%; min-height: 320px; margin: 18px 0 12px; padding: 14px; resize: vertical; border: 1px solid #d0d7de; border-radius: 7px; outline-color: #0969da; font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
button { padding: 8px 16px; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
button:disabled { cursor: wait; opacity: .65; }
.primary { color: white; background: #1f883d; }
.secondary { border-color: #d0d7de; background: #f6f8fa; }
.hidden { display: none; }
.privacy, .empty-state { text-align: center; }
@media (max-width: 600px) {
  .title-row, .file-card, .actions { align-items: stretch; flex-direction: column; }
  .file-actions { width: 100%; }
  .file-actions button { flex: 1; }
}
</style>
