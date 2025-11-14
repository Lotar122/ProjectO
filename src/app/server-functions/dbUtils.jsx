"use server"

import {SQL} from 'bun';

export async function getDb() {
	//variables loaded from .env.development or /.env.production
	return new SQL('postgres://'+DB_USER+':'+DB_PASS+'@'+DB_URL);
}

export async function newUserDb(db,uuid, username, email, passHash) {
	isEmailInUse = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
	if (!isEmailInUse){
		return {ok:await db.query(`INSERT INTO users (uuid, username, email , passHash, orders, registrationTime, emailVerified) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [uuid, username, email , passHash, [], Date.now(), false])};
	}
	return {error:{errorText: "Email already in use"}};
}

export async function getUserDb(db, passHash) {
	const user = await db.query(`SELECT * FROM users WHERE uuid = $1`, [passHash]);
	if (user) {
		return {ok:{user}};
	} else {
		return {error:{errorText: "User not found"}};
	}
}

export async function newOrderDb(db,uuid,path) {
	// TODO: add file storage
	await db.query(`INSERT INTO orders (uuid, path) VALUES ($1, $2)`, [uuid, path]);
}