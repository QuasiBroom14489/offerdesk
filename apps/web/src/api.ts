import type {
  AnyEvent,
  Application,
  ApplicationDetail,
  Contact,
  ContactDetail,
  Dashboard,
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
