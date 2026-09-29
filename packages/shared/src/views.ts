import type { Application, Contact } from './entities.js';
import type { AnyEvent } from './events.js';
import type { Status } from './status.js';

/**
 * Read models the core computes and every client renders. Types only — the
 * web bundle imports these without pulling in anything server-side.
 */

export interface FollowUp {
  kind: 'application' | 'contact';
  applicationId: string | null;
  contactId: string | null;
  /** When the silence started — the last thing we sent or did. */
  waitingSince: number;
  daysWaiting: number;
}

export interface PipelineStats {
  total: number;
  byStatus: Record<Status, number>;
  /** Applications that were actually submitted (left `saved` for the pipeline). */
  submitted: number;
  responded: number;
  /** responded / submitted, or null before anything is submitted. */
  responseRate: number | null;
  interviews: number;
  offers: number;
  funnel: { stage: string; count: number }[];
}

export interface AppRef {
  id: string;
  label: string;
}

export interface FollowUpItem extends FollowUp {
  application: AppRef | null;
  contact: { id: string; name: string; companyName: string | null } | null;
}

export interface ActivityItem {
  event: AnyEvent;
  application: AppRef | null;
  contact: { id: string; name: string } | null;
}

export interface Dashboard {
  stats: PipelineStats;
  followUps: FollowUpItem[];
  deadlines: Application[];
  recent: ActivityItem[];
}

export interface ApplicationDetail extends Application {
  timeline: AnyEvent[];
  contacts: Contact[];
}

export interface ContactDetail extends Contact {
  timeline: AnyEvent[];
}
