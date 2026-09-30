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

  async list(): Promise<SavedView[]> {
    const rows = await this.db.all<ViewRow>(
      'SELECT * FROM views WHERE workspace_id = ? ORDER BY name',
      this.workspaceId,
    );
    return [...PRESET_VIEWS, ...rows.map(fromRow)];
  }

  async get(id: string): Promise<SavedView> {
    const preset = PRESET_VIEWS.find((v) => v.id === id);
    if (preset) return preset;
    const row = await this.db.get<ViewRow>(
      'SELECT * FROM views WHERE workspace_id = ? AND id = ?',
      this.workspaceId,
      id,
    );
    if (!row) throw new NotFoundError('view', id);
    return fromRow(row);
  }

  async create(input: NewView): Promise<SavedView> {
    const v = NewView.parse(input);
    await this.assertNameFree(v.name);
    const id = randomUUID();
    const at = this.now();
    await this.db.run(
      `INSERT INTO views (id, workspace_id, name, spec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      this.workspaceId,
      v.name,
      JSON.stringify(v.spec),
      at,
      at,
    );
    return this.get(id);
  }

  async update(id: string, patch: ViewPatch): Promise<SavedView> {
    const p = ViewPatch.parse(patch);
    const current = await this.editable(id);
    if (p.name !== undefined && p.name.toLowerCase() !== current.name.toLowerCase()) {
      await this.assertNameFree(p.name);
    }
    await this.db.run(
      `UPDATE views SET name = ?, spec = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
      p.name ?? current.name,
      JSON.stringify(p.spec ?? current.spec),
      this.now(),
      this.workspaceId,
      id,
    );
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.editable(id);
    await this.db.run('DELETE FROM views WHERE workspace_id = ? AND id = ?', this.workspaceId, id);
    // Its sheet, if any, stays in Drive; only the link goes.
    await this.db.run(
      'DELETE FROM view_sheets WHERE workspace_id = ? AND view_id = ?',
      this.workspaceId,
      id,
    );
  }

  private async editable(id: string): Promise<SavedView> {
    const view = await this.get(id);
    if (view.builtIn) throw new ConflictError(`"${view.name}" is built in; save a copy instead`);
    return view;
  }

  private async assertNameFree(name: string): Promise<void> {
    const taken = (await this.list()).some(
      (v) => v.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (taken) throw new ConflictError(`a view named "${name.trim()}" already exists`);
  }
}
