"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import Error from "./error";

export default function Login({ currentpage, setCurrentPage }) {
  const [flow, setFlow] = useState(null);
  const [loginForm, setLoginForm] = useState({ identifier: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);

  const kratos = "https://orto.lotar122.dev/kratos/public";

  // Fetch BROWSER flow
  useEffect(() => {
    async function loadFlow() {
      const res = await fetch(`${kratos}/self-service/login/browser`, {
        credentials: "include",
      });

      const json = await res.json();
      setFlow(json);
    }
    loadFlow();
  }, []);

  if (!flow) return <Error />;

  const csrf = flow.ui.nodes.find(
    (n) => n.attributes.name === "csrf_token"
  )?.attributes.value;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-800">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
          <p className="text-gray-400">Sign in to your orthodontic dashboard</p>
        </div>

        {/** 🚀 REAL WORK HAPPENS HERE */}
        <form
          action={flow.ui.action}     // Kratos-provided POST URL
          method={flow.ui.method}     // Usually "POST"
          className="space-y-6"
        >
          <input type="hidden" name="csrf_token" value={csrf} />
          <input type="hidden" name="method" value="password" />

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Email Address
            </label>
            <input
              type="email"
              name="identifier"
              value={loginForm.identifier}
              onChange={(e) =>
                setLoginForm({ ...loginForm, identifier: e.target.value })
              }
              className="w-full px-4 py-3 border border-gray-700 rounded-lg bg-black text-white"
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
                type={showPassword ? "text" : "password"}
                name="password"
                value={loginForm.password}
                onChange={(e) =>
                  setLoginForm({ ...loginForm, password: e.target.value })
                }
                className="w-full px-4 py-3 border border-gray-700 rounded-lg bg-black text-white pr-12"
                placeholder="Enter your password"
                required
              />

              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
              >
                {showPassword ? (
                  <EyeOff className="w-5 h-5" />
                ) : (
                  <Eye className="w-5 h-5" />
                )}
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
            onClick={() => setCurrentPage("landing")}
            className="text-white hover:text-gray-300 font-medium"
          >
            ← Back to Home
          </button>
        </div>
      </div>
    </div>
  );
}
