import { prisma } from "../lib/prisma.js";

export type EntityRow = {
  id: string;
  accountId: string;
  [key: string]: unknown;
};

type PrismaModel = {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<EntityRow[]>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<EntityRow>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

export class EntityRepository {
  private readonly model: PrismaModel;

  constructor(public readonly entityType: string) {
    const model = (prisma as unknown as Record<string, unknown>)[entityType];
    if (!model || typeof model !== "object") {
      throw new Error(`Unknown entity type "${entityType}" — is it in your Prisma schema?`);
    }
    this.model = model as PrismaModel;
  }

  count(accountId: string): Promise<number> {
    return this.model.count({ where: { accountId } });
  }

  findByIds(accountId: string, ids: string[]): Promise<EntityRow[]> {
    return this.model.findMany({ where: { id: { in: ids }, accountId } });
  }

  findPage(accountId: string, afterId: string | undefined, take: number): Promise<EntityRow[]> {
    return this.model.findMany({
      where: {
        accountId,
        ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take,
    });
  }

  update(id: string, accountId: string, data: Record<string, unknown>): Promise<EntityRow> {
    return this.model.update({ where: { id, accountId }, data });
  }

  updateMany(accountId: string, ids: string[], data: Record<string, unknown>): Promise<{ count: number }> {
    return this.model.updateMany({ where: { id: { in: ids }, accountId }, data });
  }
}
