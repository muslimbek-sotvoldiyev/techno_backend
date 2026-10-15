import { Controller, Get, Injectable, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuthRequest } from './auth';
import { ListQuery, pagination, pageResult } from './common';
import { PrismaService } from './prisma.service';

@Injectable()
export class NotificationService {
  async send(tx: Prisma.TransactionClient, userIds: string[], type: string, title: string, orderId: string) {
    if (userIds.length) await tx.notification.createMany({ data: [...new Set(userIds)].map(userId => ({ userId, type, title, body: title, data: { orderId } })) });
  }
  async role(tx: Prisma.TransactionClient, role: Role, type: string, title: string, orderId: string) {
    const users = await tx.user.findMany({ where: { role, active: true }, select: { id: true } });
    await this.send(tx, users.map(u => u.id), type, title, orderId);
  }
}
@Controller('notifications')
export class NotificationController {
  constructor(private readonly db: PrismaService) {}
  @Get() async list(@Req() req: AuthRequest, @Query() q: ListQuery) {
    const where = { userId: req.user.id };
    const [data, total] = await this.db.$transaction([this.db.notification.findMany({ where, ...pagination(q), orderBy: { createdAt: 'desc' } }), this.db.notification.count({ where })]); return pageResult(data, total, q);
  }
  @Patch(':id/read') async read(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { await this.db.notification.updateMany({ where: { id, userId: req.user.id }, data: { readAt: new Date() } }); return { success: true }; }
}
