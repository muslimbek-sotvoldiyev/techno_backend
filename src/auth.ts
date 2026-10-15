import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Post, Req, Res, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { IsString, Matches, MinLength, MaxLength } from 'class-validator';
import { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import { PrismaService } from './prisma.service';
import { Transactions, audit } from './common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

const scryptAsync = promisify(scrypt);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const hash = await scryptAsync(password, salt, 64) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export type Actor = { id: string; name: string; phone: string; role: Role; dealerId: string | null };
export type AuthRequest = Request & { user: Actor };
export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
@Injectable()
export class ApiRateGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> { return req.user?.id ?? req.ip; }
}
export class LoginDto {
  @IsString() @Matches(/^\+?\d{9,15}$/) phone!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
}
export class PasswordDto {
  @IsString() @MaxLength(128) currentPassword!: string;
  @IsString() @MinLength(8) @MaxLength(128) newPassword!: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicUser = (user: { id: string; name: string; phone: string; role: Role; dealer: { id: string } | null }): Actor => ({ id: user.id, name: user.name, phone: user.phone, role: user.role, dealerId: user.dealer?.id ?? null });

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly db: PrismaService) {}
  async canActivate(ctx: ExecutionContext) {
    const request = ctx.switchToHttp().getRequest<AuthRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowed = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',');
      allowed.push('http://127.0.0.1:3000');
      if (origin && !allowed.includes(origin)) throw new ForbiddenException('Origin ruxsat etilmagan');
    }
    if (this.reflector.getAllAndOverride('public', [ctx.getHandler(), ctx.getClass()])) return true;
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? request.cookies?.access_token;
    try {
      const payload = await this.jwt.verifyAsync(token, { audience: 'katyol', issuer: 'katyol-api' });
      if (payload.type !== 'access') throw new Error();
      const session = await this.db.refreshSession.findUnique({ where: { id: payload.sid }, include: { user: { include: { dealer: true } } } });
      if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.active || session.userId !== payload.sub) throw new Error();
      request.user = publicUser(session.user);
      return true;
    } catch { throw new UnauthorizedException('Tizimga qayta kiring'); }
  }
}
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    const user = ctx.switchToHttp().getRequest<AuthRequest>().user;
    if (!roles || user?.role === 'ADMIN' || roles.includes(user?.role)) return true;
    throw new ForbiddenException('Bu amal uchun ruxsat yo‘q');
  }
}

@Injectable()
export class AuthService {
  constructor(private readonly db: PrismaService, private readonly jwt: JwtService, private readonly tx: Transactions) {}
  private async tokens(user: Actor, sessionId: string) {
    return {
      access: await this.jwt.signAsync({ sub: user.id, sid: sessionId, type: 'access' }, { expiresIn: '15m', audience: 'katyol', issuer: 'katyol-api' }),
      refresh: await this.jwt.signAsync({ sub: user.id, sid: sessionId, type: 'refresh', jti: randomUUID() }, { expiresIn: '7d', audience: 'katyol', issuer: 'katyol-api' }),
    };
  }
  async login(dto: LoginDto) {
    const user = await this.db.user.findUnique({ where: { phone: dto.phone }, include: { dealer: true } });
    const dummy = '0123456789abcdef0123456789abcdef:' + '00'.repeat(64);
    const valid = await verifyPassword(dto.password, user?.passwordHash ?? dummy);
    if (!user || !valid || !user.active) throw new UnauthorizedException('Telefon yoki parol noto‘g‘ri');
    const actor = publicUser(user); const id = randomUUID(); const tokens = await this.tokens(actor, id);
    await this.db.refreshSession.create({ data: { id, userId: user.id, tokenHash: digest(tokens.refresh), expiresAt: new Date(Date.now() + 7 * 86400000) } });
    return { user: actor, ...tokens };
  }
  async refresh(token?: string) {
    if (!token) throw new UnauthorizedException();
    let payload: { sid: string; sub: string; type: string };
    try { payload = await this.jwt.verifyAsync(token, { audience: 'katyol', issuer: 'katyol-api' }); } catch { throw new UnauthorizedException(); }
    if (payload.type !== 'refresh') throw new UnauthorizedException();
    return this.tx.run(async tx => {
      const session = await tx.refreshSession.findUnique({ where: { id: payload.sid }, include: { user: { include: { dealer: true } } } });
      if (!session || session.userId !== payload.sub || session.tokenHash !== digest(token) || session.revokedAt || session.expiresAt < new Date() || !session.user.active) throw new UnauthorizedException();
      const user = publicUser(session.user); const tokens = await this.tokens(user, session.id);
      await tx.refreshSession.update({ where: { id: session.id }, data: { tokenHash: digest(tokens.refresh) } });
      return { user, ...tokens };
    });
  }
  async logout(token?: string) { if (token) await this.db.refreshSession.updateMany({ where: { tokenHash: digest(token), revokedAt: null }, data: { revokedAt: new Date() } }); }
  async password(user: Actor, dto: PasswordDto) {
    const record = await this.db.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!await verifyPassword(dto.currentPassword, record.passwordHash)) throw new UnauthorizedException('Joriy parol noto‘g‘ri');
    const passwordHash = await hashPassword(dto.newPassword);
    await this.tx.run(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.refreshSession.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
      await audit(tx, user.id, 'PASSWORD_CHANGE', 'User', user.id);
    });
    return { success: true };
  }
}
function setCookies(res: Response, tokens: { access: string; refresh: string }) {
  const options = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false', path: '/' };
  res.cookie('access_token', tokens.access, { ...options, maxAge: 15 * 60000 });
  res.cookie('refresh_token', tokens.refresh, { ...options, maxAge: 7 * 86400000 });
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('login') async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) { const result = await this.auth.login(dto); setCookies(res, result); return { user: result.user }; }
  @Public() @Post('refresh') async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) { const result = await this.auth.refresh(req.cookies?.refresh_token); setCookies(res, result); return { user: result.user }; }
  @Public() @Post('logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { await this.auth.logout(req.cookies?.refresh_token); res.clearCookie('access_token', { path: '/' }); res.clearCookie('refresh_token', { path: '/' }); return { success: true }; }
  @Get('me') me(@Req() req: AuthRequest) { return req.user; }
  @Post('password') password(@Req() req: AuthRequest, @Body() dto: PasswordDto) { return this.auth.password(req.user, dto); }
}
