import type {
  AnyEvent,
  Application,
  ApplicationDetail,
  Contact,
  ContactDetail,
  Dashboard,
  Document,
  DocumentKind,
  DocumentPatch,
  Flag,
  NewApplication,
  NewContact,
  NewView,
  Report,
  SavedView,
  Status,
  ViewPatch,
  ViewSpec,
} from '@offerdesk/shared';
import { keepPreviousData, QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { UNAUTHORIZED_EVENT } from './components/Auth';
import { type PickerConfig, pickDriveFiles } from './picker';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = data?.issues?.[0];
    const detail = issue ? `${issue.path?.join('.') || 'input'}: ${issue.message}` : data?.error;
    throw new ApiError(res.status, detail ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } },
});

/** Any write can change any derived view, so writes refresh everything. */
const invalidateAll = () => queryClient.invalidateQueries();

export const useDashboard = () =>
  useQuery({ queryKey: ['dashboard'], queryFn: () => request<Dashboard>('GET', '/api/dashboard') });

export const useApplications = () =>
  useQuery({
    queryKey: ['applications'],
    queryFn: () => request<Application[]>('GET', '/api/applications'),
  });

export const useApplication = (id: string) =>
  useQuery({
    queryKey: ['applications', id],
    queryFn: () => request<ApplicationDetail>('GET', `/api/applications/${id}`),
  });

export const useContacts = () =>
  useQuery({ queryKey: ['contacts'], queryFn: () => request<Contact[]>('GET', '/api/contacts') });

export const useContact = (id: string) =>
  useQuery({
    queryKey: ['contacts', id],
    queryFn: () => request<ContactDetail>('GET', `/api/contacts/${id}`),
  });

export const useAddApplication = () =>
  useMutation({
    mutationFn: (body: NewApplication) => request<Application>('POST', '/api/applications', body),
    onSuccess: invalidateAll,
  });

export const useSetStatus = () =>
  useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) =>
      request<Application>('POST', `/api/applications/${id}/status`, { status }),
    // Optimistic board moves: the card lands immediately, the log confirms it.
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['applications'], exact: true });
      const prev = queryClient.getQueryData<Application[]>(['applications']);
      queryClient.setQueryData<Application[]>(['applications'], (apps) =>
        apps?.map((a) => (a.id === id ? { ...a, status } : a)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => queryClient.setQueryData(['applications'], ctx?.prev),
    onSettled: invalidateAll,
  });

export const useSetFlag = () =>
  useMutation({
    mutationFn: ({ id, flag, on }: { id: string; flag: Flag; on: boolean }) =>
      request<Application>('POST', `/api/applications/${id}/flags`, { flag, on }),
    onSuccess: invalidateAll,
  });

export const useAddNote = () =>
  useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      request<AnyEvent>('POST', `/api/applications/${id}/notes`, { text }),
    onSuccess: invalidateAll,
  });

export const useAddContact = () =>
  useMutation({
    mutationFn: (body: NewContact) => request<Contact>('POST', '/api/contacts', body),
    onSuccess: invalidateAll,
  });

export type OutreachChannel = 'email' | 'linkedin' | 'in-person' | 'referral' | 'other';
export type ResponseChannel = 'email' | 'linkedin' | 'phone' | 'portal' | 'other';

export const useLogOutreach = () =>
  useMutation({
    mutationFn: (body: {
      contactId?: string | null;
      applicationId?: string | null;
      channel: OutreachChannel;
      summary?: string;
    }) => request<AnyEvent>('POST', '/api/outreach', body),
    onSuccess: invalidateAll,
  });

export const useLogResponse = () =>
  useMutation({
    mutationFn: (body: {
      contactId?: string | null;
      applicationId?: string | null;
      channel: ResponseChannel;
      summary?: string;
    }) => request<AnyEvent>('POST', '/api/responses', body),
    onSuccess: invalidateAll,
  });

// ── table views ────────────────────────────────────────────────────────────

export const useViews = () =>
  useQuery({ queryKey: ['views'], queryFn: () => request<SavedView[]>('GET', '/api/views') });

/** Rows for a view, or for an edited spec on top of it. Keeps the old rows while refetching. */
export const useReport = (viewId: string, spec: ViewSpec | null) =>
  useQuery({
    queryKey: ['report', viewId, spec],
    queryFn: () => request<Report>('POST', '/api/report', spec ? { viewId, spec } : { viewId }),
    placeholderData: keepPreviousData,
  });

export const useCreateView = () =>
  useMutation({
    mutationFn: (body: NewView) => request<SavedView>('POST', '/api/views', body),
    onSuccess: invalidateAll,
  });

export const useUpdateView = () =>
  useMutation({
    mutationFn: ({ id, ...patch }: ViewPatch & { id: string }) =>
      request<SavedView>('PATCH', `/api/views/${id}`, patch),
    onSuccess: invalidateAll,
  });

export const useDeleteView = () =>
  useMutation({
    mutationFn: (id: string) => request<void>('DELETE', `/api/views/${id}`),
    onSuccess: invalidateAll,
  });

/** A plain link, so the browser handles the download. */
export function exportUrl(format: 'csv' | 'xlsx', viewId: string, spec: ViewSpec | null): string {
  const q = new URLSearchParams({ view: viewId });
  if (spec) q.set('spec', JSON.stringify(spec));
  return `/api/export.${format}?${q}`;
}

// ── documents library ──────────────────────────────────────────────────────

/** `files` is the document store's name, or null when uploads aren't set up here. */
export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: () => request<{ ok: boolean; files: string | null }>('GET', '/api/health'),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useDocuments = (archived = false) =>
  useQuery({
    queryKey: ['documents', { archived }],
    queryFn: () => request<Document[]>('GET', `/api/documents${archived ? '?archived=1' : ''}`),
  });

/** The file is the body; what describes it goes in the query string (ADR 0006). */
async function upload(url: string, file: File, params: Record<string, string | undefined>) {
  const q = new URLSearchParams({ filename: file.name });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const res = await fetch(`${url}?${q}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = data?.issues?.[0];
    throw new ApiError(
      res.status,
      issue?.message ?? data?.error ?? `Upload failed (${res.status})`,
    );
  }
  return data as Document;
}

export const useUploadDocument = () =>
  useMutation({
    mutationFn: ({ file, name, kind }: { file: File; name: string; kind: DocumentKind }) =>
      upload('/api/documents', file, { name, kind }),
    onSuccess: invalidateAll,
  });

export const useAddVersion = () =>
  useMutation({
    mutationFn: ({ id, file, note }: { id: string; file: File; note?: string }) =>
      upload(`/api/documents/${id}/versions`, file, { note }),
    onSuccess: invalidateAll,
  });

export const useUpdateDocument = () =>
  useMutation({
    mutationFn: ({ id, ...patch }: DocumentPatch & { id: string }) =>
      request<Document>('PATCH', `/api/documents/${id}`, patch),
    onSuccess: invalidateAll,
  });

export const useAttachDocument = () =>
  useMutation({
    mutationFn: ({ id, documentId }: { id: string; documentId: string }) =>
      request<Application>('POST', `/api/applications/${id}/documents`, { documentId }),
    onSuccess: invalidateAll,
  });

export const useDetachDocument = () =>
  useMutation({
    mutationFn: ({ id, documentId }: { id: string; documentId: string }) =>
      request<Application>('DELETE', `/api/applications/${id}/documents/${documentId}`),
    onSuccess: invalidateAll,
  });

/** Opens in a tab (PDFs, images); `download` saves instead. */
export function fileUrl(versionId: string, download = false): string {
  return `/api/documents/versions/${versionId}/file${download ? '?download=1' : ''}`;
}

// ── connections (ADR 0007) ─────────────────────────────────────────────────
export interface GoogleStatus {
  available: boolean;
  status: 'disconnected' | 'connected' | 'error';
  email: string | null;
  lastError: string | null;
}

export const useConnections = () =>
  useQuery({
    queryKey: ['connections'],
    queryFn: () => request<{ google: GoogleStatus }>('GET', '/api/connections'),
  });

/** Leaves the app for Google's consent screen; Google redirects back to /settings. */
export const useConnectGoogle = () =>
  useMutation({
    mutationFn: () => request<{ url: string }>('POST', '/api/connections/google/start'),
    onSuccess: ({ url }) => window.location.assign(url),
  });

export const useCheckGoogle = () =>
  useMutation({
    mutationFn: () => request<GoogleStatus>('POST', '/api/connections/google/check'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });

export const useDisconnectGoogle = () =>
  useMutation({
    mutationFn: () => request<unknown>('DELETE', '/api/connections/google'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });

export interface ViewSheet {
  viewId: string;
  spreadsheetId: string;
  url: string;
  pushedAt: number;
  changesSince: number;
}

export const useViewSheet = (viewId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['view-sheet', viewId],
    queryFn: () => request<{ sheet: ViewSheet | null }>('GET', `/api/views/${viewId}/sheet`),
    enabled,
  });

/** On demand only (ADR 0007): a sheet is a snapshot until pushed again. */
export const usePushViewSheet = () =>
  useMutation({
    mutationFn: (viewId: string) =>
      request<ViewSheet & { rows: number; created: boolean }>('POST', `/api/views/${viewId}/sheet`),
    onSuccess: (_data, viewId) => {
      queryClient.invalidateQueries({ queryKey: ['view-sheet', viewId] });
      // A 409 may have marked Google as needing a reconnect; a success clears it.
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['connections'] }),
  });

// ── Drive in and out (ADR 0007) ──────────────────────────────────────────────
export interface DriveImport {
  fileId: string;
  outcome: 'created' | 'new-version' | 'unchanged';
  document: Document;
}

/** Opens the Picker, then imports what was chosen. Resolves to null if cancelled. */
export const useImportFromDrive = () =>
  useMutation({
    mutationFn: async (opts: { applicationId?: string } = {}) => {
      const cfg = await request<PickerConfig>('GET', '/api/connections/google/picker');
      const fileIds = await pickDriveFiles(cfg);
      if (!fileIds?.length) return null;
      const { results } = await request<{ results: DriveImport[] }>(
        'POST',
        '/api/documents/import-drive',
        { fileIds, applicationId: opts.applicationId },
      );
      return results;
    },
    onSuccess: invalidateAll,
  });

export const useSaveToDrive = () =>
  useMutation({
    mutationFn: (versionId: string) =>
      request<{ url: string; created: boolean }>(
        'POST',
        `/api/documents/versions/${versionId}/drive`,
      ),
  });
