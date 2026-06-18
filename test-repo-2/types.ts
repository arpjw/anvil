// Shared domain types used across the entire service

export type AccountId = string;
export type ProductId = string;
export type OrderId = string;

export interface Account {
  id: AccountId;
  email: string;
  name: string;
  role: 'admin' | 'customer';
  createdAt: Date;
}

export interface Product {
  id: ProductId;
  name: string;
  priceInCents: number;
  stock: number;
  tags: string[];
}

export interface Order {
  id: OrderId;
  userId: AccountId;
  items: OrderItem[];
  status: OrderStatus;
  placedAt: Date;
  total: number;
}

export interface OrderItem {
  productId: ProductId;
  quantity: number;
  unitPriceInCents: number;
}

export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
