import { randomUUID } from 'node:crypto';
import { NewView, type SavedView, ViewPatch, ViewSpec } from '@offerdesk/shared';
import type { Db } from '../db.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { PRESET_VIEWS } from './presets.js';

interface ViewRow {
  id: string;
  name: string;
  spec: string;
  sheet_id: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow(r: ViewRow): SavedView {
  return {
    id: r.id,
    name: r.name,
    spec: ViewSpec.parse(JSON.parse(r.spec)),
    builtIn: false,
    sheetId: r.sheet_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Saved table views for one workspace: presets from code, then the user's own.
 * A view is configuration, not history, so it is a mutable row, not events.
 */
export class Views {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  list(): SavedView[] {
    const rows = this.db
      .prepare('SELECT * FROM views WHERE workspace_id = ? ORDER BY name')
      .all(this.workspaceId) as unknown as ViewRow[];
    return [...PRESET_VIEWS, ...rows.map(fromRow)];
  }

  get(id: string): SavedView {
    const preset = PRESET_VIEWS.find((v) => v.id === id);
    if (preset) return preset;
    const row = this.db
      .prepare('SELECT * FROM views WHERE workspace_id = ? AND id = ?')
      .get(this.workspaceId, id) as ViewRow | undefined;
    if (!row) throw new NotFoundError('view', id);
    return fromRow(row);
  }

  create(input: NewView): SavedView {
    const v = NewView.parse(input);
    this.assertNameFree(v.name);
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO views (id, workspace_id, name, spec, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.workspaceId, v.name, JSON.stringify(v.spec), at, at);
    return this.get(id);
  }

  update(id: string, patch: ViewPatch): SavedView {
    const p = ViewPatch.parse(patch);
    const current = this.editable(id);
    if (p.name !== undefined && p.name.toLowerCase() !== current.name.toLowerCase()) {
      this.assertNameFree(p.name);
    }
    this.db
      .prepare(
        `UPDATE views SET name = ?, spec = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        p.name ?? current.name,
        JSON.stringify(p.spec ?? current.spec),
        this.now(),
        this.workspaceId,
        id,
      );
    return this.get(id);
  }

  remove(id: string): void {
    this.editable(id);
    this.db
      .prepare('DELETE FROM views WHERE workspace_id = ? AND id = ?')
      .run(this.workspaceId, id);
  }

  private editable(id: string): SavedView {
    const view = this.get(id);
    if (view.builtIn) throw new ConflictError(`"${view.name}" is built in; save a copy instead`);
    return view;
  }

  private assertNameFree(name: string): void {
    const taken = this.list().some((v) => v.name.toLowerCase() === name.trim().toLowerCase());
    if (taken) throw new ConflictError(`a view named "${name.trim()}" already exists`);
  }
}
