const API_BASE = 'https://api.example.com';

async function fetchUser(id: number) {
  const response = await fetch(`${API_BASE}/users/${id}`);
  const data = await response.json();
  return data;
}

async function fetchPosts(userId: number) {
  const response = await fetch(`${API_BASE}/users/${userId}/posts`);
  const data = await response.json();
  return data;
}

async function main() {
  const user = await fetchUser(1);
  console.log('User:', user);

  const posts = await fetchPosts(user.id);
  console.log('Posts:', posts);
}

main();
