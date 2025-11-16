"use client";

import { User, Package, Calendar, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';
import { useEffect, useState } from "react";

import Loading from "./loading"

export default function Login({currentpage, setCurrentPage, isLoggedIn, setIsLoggedIn, handleLogin, loginForm, setLoginForm, showPassword})
{
	const [data, setData] = useState(null);

	useEffect(() => {
		async function load() {
		const res = await fetch("https://orto.lotar122.dev/kratos/public/self-service/login/browser", {method: "GET", credentials: "include"});
		setData(res);
		}
		load();
	}, []);

	if (!data)
	{
		useEffect(null);
		return <Loading />;
	}

	setData(null);

	console.log(data);

	const flowID = new URL(data.url).searchParams.get("flow");

	useEffect(() => {
		async function load() {
		const res = await fetch(`https://orto.lotar122.dev:4433/auth/login/flows?id=${flowID}`, {credentials: "include"}).then(r => r.json());
		setData(res);
		}
		load();
	}, []);
	
	if(!data) return <Loading />;

	console.log(data);

    return (
		  <div className="min-h-screen flex items-center justify-center p-4">
			<div className="bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-800">
			  <div className="text-center mb-8">
				<h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
				<p className="text-gray-400">Sign in to your orthodontic dashboard</p>
			  </div>
 
			  <form action={flow.ui.action} method="POST" className="space-y-6">
				<div>
				  <label className="block text-sm font-medium text-gray-300 mb-2">
					Email Address
				  </label>
				  <input
					type="email"
					value={loginForm.email}
					onChange={(e) => setLoginForm({...loginForm, email: e.target.value})}
					className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
					placeholder="Enter your email"
					required
				  />
				</div>
 
				<div>
				  <label className="block text-sm font-medium text-gray-300 mb-2">
					Password
				  </label>
				  <div className="relative">
					<input
					  type={showPassword ? 'text' : 'password'}
					  value={loginForm.password}
					  onChange={(e) => setLoginForm({...loginForm, password: e.target.value})}
					  className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white pr-12"
					  placeholder="Enter your password"
					  required
					/>
					<button
					  type="button"
					  onClick={() => setShowPassword(!showPassword)}
					  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
					>
					  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
					</button>
				  </div>
				</div>
 
				<button
				  type="submit"
				  className="w-full bg-white text-black py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200"
				>
				  Sign In
				</button>
			  </form>
 
			  <div className="mt-6 text-center">
				<button
				  onClick={() => setCurrentPage('landing')}
				  className="text-white hover:text-gray-300 font-medium"
				>
				  ← Back to Home
				</button>
			  </div>
			</div>
		  </div>
		);
}