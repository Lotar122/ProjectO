"use server"

import { getDb, getUserDb, newUserDb } from "./dbUtils"

export async function login({ request }) {
	const data = await request.json()
	const { email, password } = data

	const user=getUserDb(getDb())

	if (user.ok) /* Truthy value, NOT A BOOL*/ {
		//TODO: implement session tokens, refreshes, etc.
		return {
			success: true,
			token: "fake-token",
			message: "Logged in successfully"
		}
	} else {
		return {
			success: false,
			message: "Invalid email or password"
		}
		}
}

export async function register({ request }) {
 //TODO: your problem Adam
	const data = request.json()
	const user = {email:data.email, password:data.password, username:data.username}
	//check email validity
	const emailValid = False

	if (emailValid) {
		const userRes = newUserDb(getDb(),Bun.randomUUIDv7(), user.username, user.email, Bun.password.hash(user.email+user.password)) 
		//using a combination of email+password to make it more secure but it also makes password and email switching a little more complicated
		if (userRes.ok) {
		 return {
				success: true,
				message: "User created successfully"
		 }
		} else {
			return {
				success: false,
				message: "User creation failed"
			}
		}
	}
}

export async function logout({ request }) {
	//TODO: implement logout
	return {
		success: true,
		message: "Logged out successfully"
	}
}

export async function changePassword({ request }) {
	//TODO: implement password change
	return {
		success: true,
		message: "Password changed successfully"
	}
}

export async function changeEmail({ request }) {
	//TODO: implement email change
	return {
		success: true,
		message: "Email changed successfully"
	}
}

export async function changeUsername({ request }) {
	//TODO: implement username change
	return {
		success: true,
		message: "Username changed successfully"
	}
}

export async function deleteUser({ request }) {
 //TODO: implement user deletion
	return {
		success: true,
		message: "User deleted successfully"
	}
}

export async function verifyMail({ request }) {
 //TODO: implement email verification
 //we're all fucked actually
	return {
		success: true,
		message: "Email verified successfully"
	}
}