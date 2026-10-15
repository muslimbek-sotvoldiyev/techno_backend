import { Controller, Get, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from './prisma.service';
import { ApiRateGuard, AuthController, AuthGuard, AuthService, Public, RolesGuard } from './auth';
import { Transactions } from './common';
import { CatalogController, CatalogService } from './catalog';
import { OrdersController, OrdersService } from './orders';
import { NotificationController, NotificationService } from './notifications';
import { FinanceController, FinanceService } from './finance';
import { ReportsController, ReportsService } from './reports';

@Global()
@Module({ providers: [PrismaService, Transactions, NotificationService], exports: [PrismaService, Transactions, NotificationService] })
class DatabaseModule {}
@Module({ controllers: [CatalogController], providers: [CatalogService] })
class CatalogModule {}
@Module({ controllers: [OrdersController], providers: [OrdersService] })
class OrdersModule {}
@Module({ controllers: [FinanceController], providers: [FinanceService] })
class FinanceModule {}
@Module({ controllers: [ReportsController], providers: [ReportsService] })
class ReportsModule {}

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public() @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'katyol-api' };
  }
}

@Module({
  imports: [DatabaseModule, CatalogModule, OrdersModule, FinanceModule, ReportsModule,
    JwtModule.registerAsync({ useFactory: () => { const secret = process.env.JWT_SECRET; if (!secret || secret.length < 32) throw new Error('JWT_SECRET kamida 32 belgidan iborat bo‘lsin'); return { secret }; } }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 150 }]),
  ],
  controllers: [HealthController, AuthController, NotificationController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_GUARD, useClass: ApiRateGuard }, { provide: APP_GUARD, useClass: RolesGuard }],
})
export class AppModule {}
