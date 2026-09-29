import type { Status } from '@offerdesk/shared';
import { isoDate, type Offerdesk } from './offerdesk.js';

/**
 * Fictional data for screenshots, demos and CI. Every company and person here
 * is invented — the real database never leaves `data/`.
 */

const DAY = 86_400_000;

interface DemoApp {
  company: string;
  role: string;
  location: string;
  source: string;
  /** Days ago the application was saved. */
  savedDaysAgo: number;
  /** Status moves as [daysAgo, status]. */
  path: [number, Status][];
  deadlineInDays?: number;
}

const APPS: DemoApp[] = [
  {
    company: 'Northwind Analytics',
    role: 'Data Science Intern',
    location: 'Chicago, IL',
    source: 'Career fair',
    savedDaysAgo: 40,
    path: [
      [36, 'applied'],
      [24, 'oa'],
      [15, 'interview'],
    ],
  },
  {
    company: 'Lakeshore Capital',
    role: 'Quant Research Intern',
    location: 'New York, NY',
    source: 'Handshake',
    savedDaysAgo: 38,
    path: [
      [35, 'applied'],
      [20, 'rejected'],
    ],
  },
  {
    company: 'Kestrel Health',
    role: 'Data Analyst Intern',
    location: 'Atlanta, GA',
    source: 'Referral',
    savedDaysAgo: 34,
    path: [
      [30, 'applied'],
      [18, 'interview'],
      [6, 'offer'],
    ],
  },
  {
    company: 'Pinegrove Logistics',
    role: 'Operations Analytics Intern',
    location: 'Remote',
    source: 'LinkedIn',
    savedDaysAgo: 30,
    path: [[26, 'applied']],
  },
  {
    company: 'Brightline Media',
    role: 'Product Analytics Intern',
    location: 'San Francisco, CA',
    source: 'Company site',
    savedDaysAgo: 25,
    path: [
      [22, 'applied'],
      [9, 'oa'],
    ],
  },
  {
    company: 'Halcyon Energy',
    role: 'Data Engineering Intern',
    location: 'Houston, TX',
    source: 'Career fair',
    savedDaysAgo: 21,
    path: [[19, 'applied']],
  },
  {
    company: 'Meridian Bank',
    role: 'Risk Analytics Summer Analyst',
    location: 'Charlotte, NC',
    source: 'Info session',
    savedDaysAgo: 18,
    path: [[12, 'applied']],
  },
  {
    company: 'Quarry Labs',
    role: 'ML Engineering Intern',
    location: 'Boston, MA',
    source: 'Handshake',
    savedDaysAgo: 14,
    path: [
      [13, 'applied'],
      [4, 'ghosted'],
    ],
  },
  {
    company: 'Tidewater Insurance',
    role: 'Actuarial Data Intern',
    location: 'Hartford, CT',
    source: 'Handshake',
    savedDaysAgo: 6,
    path: [],
    deadlineInDays: 4,
  },
  {
    company: 'Orchard Retail',
    role: 'Business Intelligence Intern',
    location: 'Minneapolis, MN',
    source: 'LinkedIn',
    savedDaysAgo: 3,
    path: [],
    deadlineInDays: 9,
  },
  {
    company: 'Cobalt Sports',
    role: 'Sports Analytics Intern',
    location: 'Denver, CO',
    source: 'Club alum',
    savedDaysAgo: 2,
    path: [],
    deadlineInDays: 12,
  },
];

export function seedDemo(desk: Offerdesk, now: number = Date.now()): void {
  const ago = (days: number) => now - days * DAY;
  const ids = new Map<string, string>();

  for (const a of APPS) {
    const app = desk.addApplication({
      company: a.company,
      role: a.role,
      location: a.location,
      source: a.source,
      season: 'Summer 2027',
      deadline: a.deadlineInDays !== undefined ? isoDate(now + a.deadlineInDays * DAY) : null,
      at: ago(a.savedDaysAgo),
    });
    ids.set(a.company, app.id);
    for (const [daysAgo, status] of a.path) desk.setStatus(app.id, status, ago(daysAgo));
  }

  const id = (company: string) => ids.get(company) as string;

  const priya = desk.addContact({
    name: 'Priya Raman',
    company: 'Northwind Analytics',
    title: 'University Recruiter',
    howMet: 'Career fair booth',
  });
  const marcus = desk.addContact({
    name: 'Marcus Webb',
    company: 'Kestrel Health',
    title: 'Senior Data Analyst',
    howMet: 'Alumni network',
  });
  const elena = desk.addContact({
    name: 'Elena Ortiz',
    company: 'Pinegrove Logistics',
    title: 'Analytics Manager',
    howMet: 'LinkedIn',
  });
  const sam = desk.addContact({
    name: 'Sam Oduya',
    company: 'Meridian Bank',
    title: 'Campus Recruiting Lead',
    howMet: 'Info session',
  });
  const jun = desk.addContact({
    name: 'Jun Park',
    company: 'Brightline Media',
    title: 'Product Analyst',
    howMet: 'Club speaker event',
  });

  desk.logOutreach({
    contactId: priya.id,
    applicationId: id('Northwind Analytics'),
    channel: 'email',
    summary: 'Thank-you note after the fair',
    at: ago(35),
  });
  desk.logResponse({
    contactId: priya.id,
    applicationId: id('Northwind Analytics'),
    channel: 'email',
    summary: 'Sent OA link',
    at: ago(24),
  });
  desk.scheduleInterview(
    id('Northwind Analytics'),
    { at: now + 3 * DAY, round: 'Technical round', location: 'Zoom' },
    ago(15),
  );

  desk.logOutreach({
    contactId: marcus.id,
    applicationId: id('Kestrel Health'),
    channel: 'referral',
    summary: 'Asked for a referral',
    at: ago(31),
  });
  desk.logResponse({
    contactId: marcus.id,
    channel: 'email',
    summary: 'Submitted referral',
    at: ago(29),
  });
  desk.addNote(
    id('Kestrel Health'),
    'Offer deadline is two weeks out — compare with Northwind timeline.',
    ago(6),
  );

  desk.logOutreach({
    contactId: elena.id,
    applicationId: id('Pinegrove Logistics'),
    channel: 'linkedin',
    summary: 'Coffee chat request',
    at: ago(16),
  });
  desk.logOutreach({
    contactId: sam.id,
    applicationId: id('Meridian Bank'),
    channel: 'email',
    summary: 'Followed up after info session',
    at: ago(10),
  });
  desk.logOutreach({
    contactId: jun.id,
    channel: 'linkedin',
    summary: 'Asked about the analytics team',
    at: ago(12),
  });
  desk.logResponse({
    contactId: jun.id,
    channel: 'linkedin',
    summary: 'Happy to chat next week',
    at: ago(11),
  });
  desk.logResponse({
    applicationId: id('Brightline Media'),
    channel: 'portal',
    summary: 'OA invitation',
    at: ago(9),
  });
}
