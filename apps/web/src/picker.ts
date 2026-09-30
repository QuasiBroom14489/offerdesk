/**
 * The Google Picker (ADR 0007): the user chooses Drive files in Google's own
 * dialog, which grants this app `drive.file` access to exactly those files.
 * Loaded from apis.google.com on first use only.
 */

export interface PickerConfig {
  accessToken: string;
  apiKey: string;
  appId: string;
}

/** The slice of the Picker API used here. */
interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setMaxItems(n: number): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(cb: (data: PickerResult) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}
interface DocsView {
  setIncludeFolders(on: boolean): DocsView;
  setSelectFolderEnabled(on: boolean): DocsView;
  setMode(mode: string): DocsView;
}
interface PickerResult {
  action: string;
  docs?: { id: string }[];
}
interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId: string) => DocsView;
  ViewId: { DOCS: string };
  DocsViewMode: { LIST: string };
  Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
  Action: { PICKED: string; CANCEL: string };
}
declare global {
  interface Window {
    gapi?: { load(api: string, opts: { callback: () => void; onerror: () => void }): void };
    google?: { picker: PickerNamespace };
  }
}

let loading: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new Error('Couldn’t load the Google Picker. Check your connection and try again.'));
    };
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.onload = () => window.gapi?.load('picker', { callback: resolve, onerror: fail });
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}

/** Open the Picker; resolves to the chosen file ids, or null if cancelled. */
export async function pickDriveFiles(cfg: PickerConfig): Promise<string[] | null> {
  await loadPicker();
  const picker = window.google?.picker;
  if (!picker) throw new Error('The Google Picker didn’t load.');
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(picker.DocsViewMode.LIST);
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setMaxItems(10)
      .setOAuthToken(cfg.accessToken)
      .setDeveloperKey(cfg.apiKey)
      // The project number: picked files are granted to this app under drive.file.
      .setAppId(cfg.appId)
      .setTitle('Choose files for OfferDesk')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) resolve((data.docs ?? []).map((d) => d.id));
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
