"use server";

import axios from "axios";
import postgres from "postgres";

export async function getUserAuthSession(cookie)
{
  const cookieHeader = cookie.get("ory_kratos_session");
  let res = null;
  let loggedIn = false;
  try {
    res = await axios.get(`${Bun.env.KRATOS_PUBLIC_URL}/sessions/whoami`, {
      headers: {
        cookie: `${cookieHeader.name}=${cookieHeader.value}`,
      },
      withCredentials: false,
    });

    if (res.data && res.data.active) {
	  const DB = postgres(Bun.env.DB_URL, {prepare: true});

	  let users = null;
	  try {
		users = await DB`SELECT * FROM users WHERE "UUID" = ${res.data.identity.id}`;
	  }
	  catch(err) {
		console.error(err);
	  }

	  if(users.length == 0)
	  {
		try {
			await DB`
			INSERT INTO users ("UUID", email)
			VALUES (${res.data.identity.id}, ${res.data.identity.traits.email})
			`;
		}
		catch(err) {
			console.error(err);
		}
	  }

	  await DB.end();

      loggedIn = true;
    }
  } 
  catch (err) {
    loggedIn = false;
  }

  let result = 
  {
	loggedIn: loggedIn,
	data: res?.data
  };

  return result;
}