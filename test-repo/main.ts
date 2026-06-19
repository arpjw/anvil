const API_BASE = 'https://api.example.com';

/**
 * Fetches a user by their ID from the API.
 *
 * @param id - The unique numeric identifier of the user to retrieve.
 * @returns A promise that resolves to the user data returned by the API.
 * @throws A TypeError if `id` is null, undefined, not a number, or NaN.
 * @throws An error if the HTTP response is not OK or if the request fails.
 */
async function fetchUser(id: number) {
  if (id === null || id === undefined) {
    throw new TypeError('fetchUser: "id" is required and cannot be null or undefined.');
  }
  if (typeof id !== 'number' || isNaN(id)) {
    throw new TypeError(`fetchUser: "id" must be a valid number, but received ${typeof id === 'number' ? 'NaN' : `"${typeof id}"`}.`);
  }

  try {
    const response = await fetch(`${API_BASE}/users/${id}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch user ${id}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error fetching user ${id}:`, error);
    throw error;
  }
}

async function fetchPosts(userId: number) {
  if (userId === null || userId === undefined) {
    throw new TypeError('fetchPosts: "userId" is required and cannot be null or undefined.');
  }
  if (typeof userId !== 'number' || isNaN(userId)) {
    throw new TypeError(`fetchPosts: "userId" must be a valid number, but received ${typeof userId === 'number' ? 'NaN' : `"${typeof userId}"`}.`);
  }

  try {
    const response = await fetch(`${API_BASE}/users/${userId}/posts`);
    if (!response.ok) {
      throw new Error(`Failed to fetch posts for user ${userId}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error fetching posts for user ${userId}:`, error);
    throw error;
  }
}

async function main() {
  const user = await fetchUser(1);
  console.log('User:', user);

  const posts = await fetchPosts(user.id);
  console.log('Posts:', posts);
}

main();
