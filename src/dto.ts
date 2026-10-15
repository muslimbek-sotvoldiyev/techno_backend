import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested, IsUrl } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { BunkerPosition, OrderStatus, PaymentMethod, Role } from '@prisma/client';
export class CustomerDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @ApiProperty() @Matches(/^\+?\d{9,15}$/) phone!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?\d{9,15}$/) secondaryPhone?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) region!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) district!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(500) address!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) landmark?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() dealerId?: string;
}
export class CustomerUpdate extends PartialType(CustomerDto) {}
export class CategoryDto { @IsString() @MinLength(1) @MaxLength(100) name!: string; }
export class WarehouseDto extends CategoryDto { @IsString() @MinLength(1) @MaxLength(500) address!: string; }
export class ProductDto extends CategoryDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) model!: string;
  @ApiProperty() @IsUUID() categoryId!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(10000) powerKw!: number;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{1,12}(\.\d{1,2})?$/) costPrice?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{1,12}(\.\d{1,2})?$/) dealerPrice = '0';
  @ApiProperty() @Matches(/^\d{1,12}(\.\d{1,2})?$/) salePrice!: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ protocols: ['https', 'http'], require_protocol: true }) imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}
export class ProductUpdate extends PartialType(ProductDto) {}
export class UserDto extends CategoryDto {
  @ApiProperty() @Matches(/^\+?\d{9,15}$/) phone!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @ApiProperty() @IsEnum(Role) role!: Role;
}
export class UserUpdate {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(Role) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) @MaxLength(128) password?: string;
}

export class ItemDto {
  @ApiPropertyOptional() @IsOptional() @IsEnum({ AT: 'AT', ATK: 'ATK' }) boilerType?: 'AT' | 'ATK';
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(10000) quantity!: number;
  @ApiProperty() @Matches(/^\d{1,12}(\.\d{1,2})?$/) salePrice!: string;
}
export class OrderDto {
  @ApiPropertyOptional({ enum: BunkerPosition }) @IsOptional() @IsEnum(BunkerPosition) bunkerPosition?: BunkerPosition;
  @ApiPropertyOptional() @IsOptional() @ValidateNested() @Type(() => CustomerDto) customer?: CustomerDto;
  @ApiPropertyOptional() @IsOptional() @IsDateString() orderDate?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{1,12}(\.\d{1,2})?$/) deposit?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum({ UZB: 'UZB', TURK: 'TURK', XITOY: 'XITOY' }) controlPanel?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(9) @IsEnum({ BUNKER: 'BUNKER', MOTOR: 'MOTOR', BLOWER: 'BLOWER', BRUSH: 'BRUSH', STABILIZER: 'STABILIZER', POKER: 'POKER', ASH_PAN: 'ASH_PAN', COAL: 'COAL', PASSPORT: 'PASSPORT' }, { each: true }) accessories?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() dealerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(500) address!: string;
  @ApiProperty() @Matches(/^\+?\d{9,15}$/) phone!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @ApiProperty() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
}
export class StatusDto {
  @ApiProperty() @IsEnum(OrderStatus) status!: OrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) cancellationReason?: string;
}

export class PaymentItemPriceDto {
  @ApiProperty() @IsUUID() id!: string;
  @ApiProperty() @Matches(/^\d{1,12}(\.\d{1,2})?$/) salePrice!: string;
}
export class PaymentDto {
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => PaymentItemPriceDto) itemPrices?: PaymentItemPriceDto[];
  @ApiProperty() @IsUUID() orderId!: string;
  @ApiProperty() @Matches(/^\d{1,12}(\.\d{1,2})?$/) amount!: string;
  @ApiProperty() @IsEnum(PaymentMethod) method!: PaymentMethod;
  @ApiProperty() @IsUUID() idempotencyKey!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() paidAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class LedgerDto {
  @ApiProperty() @Matches(/^-?\d{1,12}(\.\d{1,2})?$/) amount!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(2000) reason!: string;
  @ApiProperty() @IsUUID() reference!: string;
}
