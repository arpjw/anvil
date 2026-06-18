// Entry point — wires everything together and runs a demo scenario

import { createAccount, createProduct } from './db.js';
import { login, logout } from './auth.js';
import { placeOrder, cancelOrder, getUserOrders } from './orders.js';
import { centsToDisplay, formatDate } from './utils.js';

function demo(): void {
  // Seed some data
  const alice = createAccount({ email: 'alice@example.com', name: 'Alice', role: 'admin' });
  const bob   = createAccount({ email: 'bob@example.com',   name: 'Bob',   role: 'customer' });

  const widget = createProduct({ name: 'Widget', priceInCents: 999,  stock: 100, tags: ['hardware'] });
  const gadget = createProduct({ name: 'Gadget', priceInCents: 2499, stock: 5,   tags: ['electronics'] });

  console.log(`Seeded users: ${alice.name}, ${bob.name}`);
  console.log(`Seeded products: ${widget.name} (${centsToDisplay(widget.priceInCents)}), ${gadget.name} (${centsToDisplay(gadget.priceInCents)})`);

  // Bob logs in and places an order
  const { token: bobToken } = login(bob.email, 'secret');
  const order = placeOrder(bobToken, [
    { productId: widget.id, quantity: 2 },
    { productId: gadget.id, quantity: 1 },
  ]);

  console.log(`\nOrder placed: ${order.id}`);
  console.log(`  Status: ${order.status}`);
  console.log(`  Total:  ${centsToDisplay(order.total)}`);
  console.log(`  Placed: ${formatDate(order.placedAt)}`);

  // Bob checks his orders
  const bobOrders = getUserOrders(bobToken);
  console.log(`\nBob's orders: ${bobOrders.length}`);

  // Bob cancels the order
  const cancelled = cancelOrder(bobToken, order.id);
  console.log(`Order cancelled: ${cancelled.status}`);

  logout(bobToken);

  // Alice logs in
  const { token: aliceToken } = login(alice.email, 'adminpass');
  const aliceOrders = getUserOrders(aliceToken);
  console.log(`\nAlice's orders: ${aliceOrders.length}`);
  logout(aliceToken);
}

demo();
