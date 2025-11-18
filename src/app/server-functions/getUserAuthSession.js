"use server";

export async function getUserAuthSession(cookieHeader)
{
  cookieHeader = cookieHeader.get("ory_kratos_session");
  try {
    const res = await axios.get(`${Bun.env.KRATOS_PUBLIC_URL}/sessions/whoami`, {
      headers: {
        cookie: `${cookieHeader.name}=${cookieHeader.value}`,
      },
      withCredentials: false,
    });

    if (res.data && res.data.active) {
	  const DB = postgres(Bun.env.DB_URL, {prepare: true});

	  let users = null;
	  try {
		users = await DB`SELECT * FROM users WHERE "UUID" = ${res.data.id}`;
	  }
	  catch(err) {
		console.error(err);
	  }

	  if(users.length == 0)
	  {
		try {
			await DB`
			INSERT INTO users ("UUID", email)
			VALUES (${res.data.id}, ${res.data.identity.traits.email})
			`;
		}
		catch(err) {
			console.error(err);
		}
	  }

	  await DB.end();

      loggedIn = true;
    }
  } catch (err) {
    loggedIn = false;
  }

  let result = 
  {
	loggedIn: loggedIn,
	data: res.data
  };

  return result;
}