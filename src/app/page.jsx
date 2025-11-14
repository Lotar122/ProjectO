"use client";

import React, { useState, useEffect } from 'react';
import { User, Package, Calendar, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';
 
const App = () => {
  const [currentPage, setCurrentPage] = useState('loading');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [orders, setOrders] = useState([
    { id: 'ORD-001', patient: 'John Smith', appliance: 'Invisalign Full', status: 'completed', date: '2023-05-15', progress: 100 },
    { id: 'ORD-002', patient: 'Sarah Johnson', appliance: 'Traditional Braces', status: 'in-progress', date: '2023-06-20', progress: 65 },
    { id: 'ORD-003', patient: 'Mike Davis', appliance: 'Clear Aligners', status: 'pending', date: '2023-07-10', progress: 20 },
    { id: 'ORD-004', patient: 'Emily Chen', appliance: 'Lingual Braces', status: 'shipped', date: '2023-08-05', progress: 90 },
  ]);
  const [showPassword, setShowPassword] = useState(false);
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [newOrder, setNewOrder] = useState({ patient: '', appliance: '', notes: '' });
 
  useEffect(() => {
    // Simulate loading
    const timer = setTimeout(() => {
      setCurrentPage('landing');
    }, 2000);
    return () => clearTimeout(timer);
  }, []);
 
  const handleLogin = (e) => {
    e.preventDefault();
    // Simple validation
    if (loginForm.email && loginForm.password) {
      setIsLoggedIn(true);
      setCurrentPage('orders');
    }
  };
 
  const handleLogout = () => {
    setIsLoggedIn(false);
    setCurrentPage('landing');
  };
 
  const handleCreateOrder = (e) => {
    e.preventDefault();
    if (newOrder.patient && newOrder.appliance) {
      const order = {
        id: `ORD-${String(orders.length + 1).padStart(3, '0')}`,
        patient: newOrder.patient,
        appliance: newOrder.appliance,
        status: 'pending',
        date: new Date().toISOString().split('T')[0],
        progress: 10
      };
      setOrders([...orders, order]);
      setNewOrder({ patient: '', appliance: '', notes: '' });
      setCurrentPage('orders');
    }
  };
 
  const getStatusColor = (status) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'in-progress': return 'bg-blue-100 text-blue-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'shipped': return 'bg-purple-100 text-purple-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };
 
  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-4 h-4" />;
      case 'in-progress': return <Clock className="w-4 h-4" />;
      case 'pending': return <Clock className="w-4 h-4" />;
      case 'shipped': return <Package className="w-4 h-4" />;
      default: return <XCircle className="w-4 h-4" />;
    }
  };
 
  if (currentPage === 'loading') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="w-24 h-24 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <h1 className="text-3xl font-bold text-white mb-2">ProjectO</h1>
          <p className="text-gray-400">Orthodontic Management System</p>
        </div>
      </div>
    );
  }
 
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-black">
        {currentPage === 'landing' && (
          <div className="container mx-auto px-4 py-16">
            <div className="text-center mb-16">
              <h1 className="text-5xl font-bold text-white mb-6">ProjectO</h1>
              <p className="text-xl text-gray-400 max-w-2xl mx-auto">
                Advanced orthodontic management system for streamlined patient care and order tracking
              </p>
            </div>
 
            <div className="grid md:grid-cols-3 gap-8 mb-16">
              <div className="bg-gray-900 rounded-xl p-8 text-center text-white">
                <Package className="w-12 h-12 mx-auto mb-4 text-white" />
                <h3 className="text-xl font-semibold mb-2">Order Management</h3>
                <p>Track and manage all orthodontic appliance orders efficiently</p>
              </div>
              <div className="bg-gray-900 rounded-xl p-8 text-center text-white">
                <Calendar className="w-12 h-12 mx-auto mb-4 text-white" />
                <h3 className="text-xl font-semibold mb-2">Progress Tracking</h3>
                <p>Monitor treatment progress and order status in real-time</p>
              </div>
              <div className="bg-gray-900 rounded-xl p-8 text-center text-white">
                <User className="w-12 h-12 mx-auto mb-4 text-white" />
                <h3 className="text-xl font-semibold mb-2">Patient Care</h3>
                <p>Enhanced patient management and treatment coordination</p>
              </div>
            </div>
 
            <div className="text-center">
              <button
                onClick={() => setCurrentPage('login')}
                className="bg-white text-black px-8 py-4 rounded-xl font-semibold text-lg hover:bg-gray-200 transition-colors duration-200 flex items-center gap-2 mx-auto"
              >
                <LogIn className="w-5 h-5" />
                Access Dashboard
              </button>
            </div>
          </div>
        )}
 
        {currentPage === 'login' && (
          <div className="min-h-screen flex items-center justify-center p-4">
            <div className="bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-800">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
                <p className="text-gray-400">Sign in to your orthodontic dashboard</p>
              </div>
 
              <form onSubmit={handleLogin} className="space-y-6">
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
        )}
      </div>
    );
  }
 
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center">
                <Package className="w-6 h-6 text-black" />
              </div>
              <h1 className="text-2xl font-bold text-white">ProjectO</h1>
            </div>
 
            <nav className="hidden md:flex items-center gap-6">
              <button
                onClick={() => setCurrentPage('orders')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                  currentPage === 'orders' ? 'bg-white text-black' : 'text-gray-300 hover:text-white'
                }`}
              >
                <Package className="w-4 h-4" />
                Orders
              </button>
              <button
                onClick={() => setCurrentPage('create-order')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                  currentPage === 'create-order' ? 'bg-white text-black' : 'text-gray-300 hover:text-white'
                }`}
              >
                <Plus className="w-4 h-4" />
                New Order
              </button>
            </nav>
 
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 text-sm text-gray-300">
                <UserCircle className="w-5 h-5" />
                Dr. Smith
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 text-gray-300 hover:text-white transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>
 
      {/* Mobile Navigation */}
      <div className="md:hidden bg-gray-900 border-b border-gray-800">
        <div className="container mx-auto px-4 py-3">
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentPage('orders')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                currentPage === 'orders' ? 'bg-white text-black' : 'text-gray-300'
              }`}
            >
              <Package className="w-4 h-4" />
              Orders
            </button>
            <button
              onClick={() => setCurrentPage('create-order')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                currentPage === 'create-order' ? 'bg-white text-black' : 'text-gray-300'
              }`}
            >
              <Plus className="w-4 h-4" />
              New
            </button>
          </div>
        </div>
      </div>
 
      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {currentPage === 'orders' && (
          <div>
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-3xl font-bold text-white">Treatment Orders</h2>
                <p className="text-gray-400">Manage and track all orthodontic appliance orders</p>
              </div>
              <button
                onClick={() => setCurrentPage('create-order')}
                className="bg-white text-black px-6 py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200 flex items-center gap-2"
              >
                <Plus className="w-5 h-5" />
                New Order
              </button>
            </div>
 
            {/* Search and Filter */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-8">
              <div className="flex flex-col md:flex-row gap-4">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    type="text"
                    placeholder="Search orders..."
                    className="w-full pl-10 pr-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
                  />
                </div>
                <div className="flex gap-2">
                  <select className="px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white">
                    <option className="bg-gray-900">All Status</option>
                    <option className="bg-gray-900">Pending</option>
                    <option className="bg-gray-900">In Progress</option>
                    <option className="bg-gray-900">Shipped</option>
                    <option className="bg-gray-900">Completed</option>
                  </select>
                  <button className="px-4 py-3 border border-gray-700 rounded-lg hover:bg-gray-800 transition-colors bg-black text-white">
                    <Filter className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
 
            {/* Orders Grid */}
            <div className="grid gap-6">
              {orders.map((order) => (
                <div key={order.id} className="bg-gray-900 rounded-xl border border-gray-800 p-6 hover:border-gray-600 transition-colors duration-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center">
                        <Package className="w-6 h-6 text-black" />
                      </div>
                      <div>
                        <h3 className="text-lg font-semibold text-white">{order.patient}</h3>
                        <p className="text-gray-400">{order.appliance}</p>
                        <p className="text-sm text-gray-500">Order #{order.id} • {order.date}</p>
                      </div>
                    </div>
 
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(order.status)}`}>
                          {getStatusIcon(order.status)}
                          {order.status.replace('-', ' ').toUpperCase()}
                        </span>
                        <div className="mt-2 w-32 bg-gray-700 rounded-full h-2">
                          <div 
                            className={`h-2 rounded-full transition-all duration-300 ${
                              order.status === 'completed' ? 'bg-green-500' :
                              order.status === 'in-progress' ? 'bg-blue-500' :
                              order.status === 'shipped' ? 'bg-purple-500' : 'bg-yellow-500'
                            }`}
                            style={{ width: `${order.progress}%` }}
                          ></div>
                        </div>
                        <p className="text-sm text-gray-500 mt-1">{order.progress}% Complete</p>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
 
        {currentPage === 'create-order' && (
          <div>
            <div className="mb-8">
              <h2 className="text-3xl font-bold text-white mb-2">Create New Order</h2>
              <p className="text-gray-400">Enter patient details and appliance information</p>
            </div>
 
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 max-w-2xl mx-auto">
              <form onSubmit={handleCreateOrder} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Patient Name
                  </label>
                  <input
                    type="text"
                    value={newOrder.patient}
                    onChange={(e) => setNewOrder({...newOrder, patient: e.target.value})}
                    className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
                    placeholder="Enter patient full name"
                    required
                  />
                </div>
 
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Appliance Type
                  </label>
                  <select
                    value={newOrder.appliance}
                    onChange={(e) => setNewOrder({...newOrder, appliance: e.target.value})}
                    className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
                    required
                  >
                    <option className="bg-gray-900" value="">Select appliance type</option>
                    <option className="bg-gray-900" value="Invisalign Full">Invisalign Full</option>
                    <option className="bg-gray-900" value="Invisalign Teen">Invisalign Teen</option>
                    <option className="bg-gray-900" value="Traditional Braces">Traditional Braces</option>
                    <option className="bg-gray-900" value="Clear Aligners">Clear Aligners</option>
                    <option className="bg-gray-900" value="Lingual Braces">Lingual Braces</option>
                    <option className="bg-gray-900" value="Self-Ligating Braces">Self-Ligating Braces</option>
                  </select>
                </div>
 
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Additional Notes
                  </label>
                  <textarea
                    value={newOrder.notes}
                    onChange={(e) => setNewOrder({...newOrder, notes: e.target.value})}
                    className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white h-32 resize-none"
                    placeholder="Any special instructions or notes..."
                  />
                </div>
 
                <div className="flex gap-4">
                  <button
                    type="submit"
                    className="flex-1 bg-white text-black py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200"
                  >
                    Create Order
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentPage('orders')}
                    className="flex-1 bg-gray-700 text-white py-3 rounded-lg font-semibold hover:bg-gray-600 transition-colors duration-200"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
 
export default App;