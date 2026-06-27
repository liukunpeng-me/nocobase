/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

type IndexInfo = { name: string };

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    await this.backfillPurpose();
    await this.backfillAiFilesKind();
    await this.ensureSourceHashIndex();
  }

  async backfillPurpose() {
    const collection = this.db.getCollection('llmServices');
    if (!collection) {
      return;
    }
    const field = collection.getField('purpose');
    if (!field) {
      return;
    }
    const tableName = collection.getTableNameWithSchema();
    const columnName = field.columnName();
    await this.db.sequelize.getQueryInterface().bulkUpdate(tableName, { [columnName]: 'llm' }, { [columnName]: null });
  }

  async backfillAiFilesKind() {
    const collection = this.db.getCollection('aiFiles');
    if (!collection) {
      return;
    }
    const field = collection.getField('kind');
    if (!field) {
      return;
    }
    const tableName = collection.getTableNameWithSchema();
    const columnName = field.columnName();
    await this.db.sequelize
      .getQueryInterface()
      .bulkUpdate(tableName, { [columnName]: 'attachment' }, { [columnName]: null });
  }

  async ensureSourceHashIndex() {
    const collection = this.db.getCollection('aiFiles');
    if (!collection) {
      return;
    }
    const field = collection.getField('sourceHash');
    if (!field) {
      return;
    }
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    const columnName = field.columnName();
    const indexName = 'ai_files_source_hash';

    const tableExists = await queryInterface.tableExists(tableName);
    if (!tableExists) {
      return;
    }

    const existing = (await queryInterface.showIndex(tableName)) as IndexInfo[];
    if (existing.some((index) => index.name === indexName)) {
      return;
    }

    await queryInterface.addIndex(tableName, [columnName], {
      name: indexName,
    });
  }
}
