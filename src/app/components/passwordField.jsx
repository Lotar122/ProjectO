"use client";

import { Eye, EyeOff } from "lucide-react"
import React, { useState } from "react"

export default function PasswordField({ password, setPassword })
{
    const [showPassword, setShowPassword] = useState(false);

    return (
        <div>
				  <label className="block text-sm font-medium text-gray-300 mb-2">
					Password
				  </label>
				  <div className="relative">
					<input
					  type={showPassword ? 'text' : 'password'}
					  value={password}
					  onChange={(e) => setPassword(e.target.value)}
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
    );
}