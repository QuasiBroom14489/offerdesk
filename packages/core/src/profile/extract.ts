import { createHash } from 'node:crypto';
import { ProfileContent, type SourceUpload } from '@offerdesk/shared';
import { parseDocument } from 'yaml';

export const EXTRACTOR_VERSION = 4;
export const hashText = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
export const identity = (record: ProfileContent) =>
  `${record.category}:${(record.fields.Company || record.name)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')}`;
export interface Extracted {
  content: ProfileContent;
  section: string;
  warnings: string[];
}
const clean = (s: string) =>
  s
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, target, label) => label || target.split('/').pop(),
    )
    .replace(/\*\*|__/g, '')
    .trim();
const workFields = (title: string, company: string, description = '') => ({
  'Job Title': title,
  Company: company,
  Location: '',
  'Start Date': '',
  'End Date': '',
  'Currently Employed': '',
  Description: description,
});
const categoryFor = (heading: string): ProfileContent['category'] | undefined => {
  if (/education|coursework|academic/i.test(heading)) return 'Education';
  if (/skill|language|framework|frontend|backend|build & deploy|^data$/i.test(heading))
    return 'Skills';
  if (/leadership|volunteer|activities|team leader/i.test(heading)) return 'Leadership';
  if (/project/i.test(heading)) return 'Projects';
  if (
    /career interest|leadership example|technical challenge|teamwork|problem.solving|accomplishment/i.test(
      heading,
    )
  )
    return 'Common Questions';
  if (/experience|employment|resume bullet/i.test(heading)) return 'Work Experience';
  return undefined;
};

/** Local deterministic extraction. No model, remote calls, link following, HTML, or code execution. */
export async function extractSource(file: SourceUpload): Promise<Extracted[]> {
  if (file.kind === 'resume') {
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > 4_000_000 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('Select a PDF resume smaller than 4 MB');
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: bytes });
    try {
      return extractResume((await parser.getText()).text);
    } finally {
      await parser.destroy();
    }
  }
  if (!/\.md$/i.test(file.name) || Buffer.byteLength(file.content) > 500_000)
    throw new Error('Select Markdown notes smaller than 500 KB');
  return extractMarkdown(file.content, file.name);
}

export function extractMarkdown(raw: string, filename: string): Extracted[] {
  const result: Extracted[] = [];
  let text = raw.replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (fm) {
    const doc = parseDocument(fm[1]!);
    if (doc.errors.length) throw new Error('Invalid YAML frontmatter');
    const meta = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
    // Explicit opt-out wins even for a manually selected note.
    if (meta?.private === true || meta?.autofill === false) return [];
    // Optional structured interchange; only known schema fields survive.
    const explicit = ProfileContent.safeParse(meta?.application_profile);
    if (explicit.success)
      result.push({
        content: explicit.data,
        section: 'frontmatter.application_profile',
        warnings: [],
      });
    text = text.slice(fm[0].length);
  }
  text = text.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const sections: {
    heading: string;
    path: string;
    context: string;
    lines: string[];
    category?: ProfileContent['category'];
  }[] = [];
  const ancestry: string[] = [];
  let heading = filename.replace(/\.md$/, '').split('/').pop() || 'Professional note';
  let category = categoryFor(heading);
  let current = { heading, path: heading, context: heading, lines: [] as string[], category };
  sections.push(current);
  for (const line of text.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.+)/);
    if (h) {
      heading = clean(h[2]!);
      const level = h[1]!.length;
      ancestry.length = level - 1;
      ancestry[level - 1] = heading;
      category = categoryFor(heading) ?? category;
      current = {
        heading,
        path: ancestry.filter(Boolean).join(' / '),
        context: ancestry[1] || heading,
        lines: [],
        category,
      };
      sections.push(current);
    } else current.lines.push(line);
  }
  for (const section of sections) {
    const assertion = section.lines
      .map(clean)
      .find(
        (line) => /^(?:Selected as|Served as)\b/.test(line) && line.length < 500 && !/@/.test(line),
      );
    if (assertion && section.category === 'Leadership')
      result.push({
        content: { category: 'Leadership', name: section.path, fields: { Description: assertion } },
        section: section.path,
        warnings: ['Verify role scope, dates and organization before accepting.'],
      });
    if (
      /action items|related|networking|contacts|stakeholder|env vars|style rule|header line|notes for tailoring|compressed|linkedin experience/i.test(
        section.heading,
      )
    )
      continue;
    // Keep only explicit accomplished-work assertions, never checklists, plans, contacts, instructions or whole paragraphs.
    const bullets = section.lines
      .filter((line) => /^\s*[-*]\s+(?!\[)/.test(line))
      .map((line) => clean(line.replace(/^\s*[-*]\s+/, '')))
      .filter(
        (line) =>
          !/@|\b(?:password|secret|token|api.key|phone|email|should|could|plan to|need to|todo)\b/i.test(
            line,
          ),
      )
      .filter((line) =>
        /^(?:Shipped|Designed|Built|Implemented|Structured|Set up|Led|Authored|Advised|Partnered|Owned|Completed|Cleaned|Analyzed|Managed|Developed|Created|Selected|Wrote|Organized|Collaborated|Languages:|Frameworks|Data:)/i.test(
          line,
        ),
      );
    if (!bullets.length || !section.category) continue;
    result.push({
      content: {
        category: section.category,
        name: section.path,
        fields:
          section.category === 'Work Experience'
            ? { ...workFields('', section.context, bullets.join('\n')) }
            : { Description: bullets.join('\n') },
      },
      section: section.path,
      warnings: [
        'Extracted from selected note; verify ownership and completed work before accepting.',
      ],
    });
  }
  // A project name in frontmatter is evidence of a project, not evidence that its future tasks were completed.
  if (!result.length && fm) {
    const meta = parseDocument(fm[1]!).toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
    if (typeof meta?.project === 'string')
      result.push({
        content: { category: 'Projects', name: clean(meta.project), fields: { Description: '' } },
        section: 'frontmatter.project',
        warnings: ['Project discovered; responsibilities and dates require review.'],
      });
  }
  return result;
}

export function extractResume(raw: string): Extracted[] {
  const text = raw
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/^--\s*\d+ of \d+\s*--$/gm, '');
  const out: Extracted[] = [];
  const add = (
    category: ProfileContent['category'],
    name: string,
    fields: Record<string, string>,
    section: string,
    warnings: string[] = [],
  ) => out.push({ content: { category, name, fields }, section, warnings });
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const contactEnd = lines.findIndex((l) => /^SUMMARY|^EDUCATION|^EXPERIENCE/i.test(l));
  const contacts = lines.slice(0, contactEnd < 0 ? 3 : contactEnd).join(' ');
  const email = contacts.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || '';
  const phone = contacts.match(/(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/)?.[0] || '';
  const first = lines[0] || '';
  if (email || phone)
    add(
      'Personal Information',
      'Contact information',
      {
        'Full Name': first,
        Email: email,
        Phone: phone,
        Location: (contacts.match(/([A-Za-z ]+,\s*[A-Z]{2})\s*[•|]/)?.[1] || '').trim(),
        LinkedIn: contacts.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s•]+/)?.[0] || '',
        GitHub: contacts.match(/(?:https?:\/\/)?github\.com\/[^\s•]+/)?.[0] || '',
        Portfolio:
          contacts
            .split(/[•|]/)
            .map((s) => s.trim())
            .find(
              (s) => /^[\w.-]+\.(com|dev|io|net)(?:\/\S*)?$/.test(s) && !/github|linkedin/.test(s),
            ) || '',
      },
      'Header',
    );
  let section = '';
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    if (section === 'SUMMARY') {
      add(
        'Common Questions',
        'Career interests',
        { Question: 'What are your career interests?', Answer: block.join(' ') },
        section,
      );
    } else if (section === 'EDUCATION') {
      const [institution = '', degree = ''] = block[0]!.split(/\s+[—–]\s+/);
      add(
        'Education',
        institution,
        {
          Institution: institution,
          Degree: degree.split('|')[0]!.trim(),
          Major: degree.match(/\bin\s+([^|]+)/i)?.[1]?.trim() || '',
          'Graduation Date':
            block
              .join(' ')
              .match(/Expected\s+([^|\n]+?)(?=Relevant Coursework:|$)/i)?.[1]
              ?.trim() || '',
          Coursework: block.join(' ').split(/Relevant Coursework:\s*/i)[1] || '',
        },
        section,
      );
    } else if (section === 'SKILLS') {
      const groups = block.join(' ').split(/(?=Languages:|Frameworks & Tools:|Data:|Spoken:)/);
      for (const group of groups) {
        const colon = group.indexOf(':');
        if (colon > 0)
          add('Skills', group.slice(0, colon), { Skills: group.slice(colon + 1).trim() }, section);
      }
    } else if (section === 'EXPERIENCE') {
      const [title = '', company = ''] = block[0]!.split(/\s+[—–]\s+/);
      if (!company) return;
      const dateLine = block[1] || '';
      const [location = '', dates = ''] = dateLine.includes('|')
        ? dateLine.split('|').map((s) => s.trim())
        : ['', dateLine];
      const [start = '', end = ''] = dates.split(/\s+[–—-]\s+/);
      // A combined employer line is ambiguous. Keep employers separate and shared facts out of both canonical records.
      const employers = company.split(/;\s*/);
      for (const employer of employers) {
        const fields = workFields(
          employers.length > 1 ? '' : title,
          employer,
          employers.length > 1 ? '' : block.slice(2).join(' '),
        );
        fields.Location = location;
        if (employers.length === 1) {
          fields['Start Date'] = start;
          fields['End Date'] = /present|current/i.test(end) ? '' : end;
          fields['Currently Employed'] = end ? String(/present|current/i.test(end)) : '';
        }
        add(
          'Work Experience',
          employer,
          fields,
          `${section} / ${block[0]}`,
          employers.length > 1
            ? [
                `Combined resume entry: ${title}; shared period ${dates}. Confirm individual title, dates and responsibilities.`,
              ]
            : [],
        );
      }
    } else if (section === 'PROJECTS') {
      const [name = '', technologies = ''] = block[0]!.split(/\s+[—–]\s+/);
      add(
        'Projects',
        name,
        { Technologies: technologies, Description: block.slice(1).join(' ') },
        `${section} / ${name}`,
      );
    }
    block = [];
  };
  for (const [lineIndex, line] of lines.entries()) {
    if (/^(SUMMARY|EDUCATION|SKILLS|EXPERIENCE|PROJECTS|LEADERSHIP|ACTIVITIES)$/.test(line)) {
      flush();
      block = [];
      section = line;
      continue;
    }
    if (!['SUMMARY', 'EDUCATION', 'SKILLS', 'EXPERIENCE', 'PROJECTS'].includes(section)) continue;
    const nextLine = lines[lineIndex + 1] || '';
    const titleLine =
      /\s+[—–]\s+/.test(line) &&
      !/\|/.test(line) &&
      !/^(Designed|Built|Led|Advised|Structured|Managed|Completed|Analyzed|Created|Implemented)/.test(
        line,
      );
    if (
      titleLine &&
      ((section === 'EXPERIENCE' &&
        /(?:\b(?:19|20)\d{2}\b)/.test(nextLine) &&
        nextLine.length < 120) ||
        (section === 'PROJECTS' && line.length < 160))
    )
      flush();
    block.push(line);
  }
  flush();
  return out;
}
