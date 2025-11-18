"use client";

import React, { useEffect, useRef, useState } from "react";
import { User, Package, Calendar, Trash2, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';

import axios from "axios";

let ordersArray = [];
let ordersToBeDisplayed = structuredClone(ordersArray);

export default function Orders()
{
    const [currentPage, setCurrentPage] = useState('orders');
    const [orders, setOrders] = useState(ordersToBeDisplayed);
    const [newOrder, setNewOrder] = useState({ patient: '', type: '', notes: '' });
    const orderFilterRef = useRef(null);
    const orderSearchRef = useRef(null);

    const [hoveredOrder, setHoveredOrder] = useState(null);
    const [deleteOrderId, setDeleteOrderId] = useState(null);

    useEffect(() => {
      const res = axios.get('/api/getOrders', {withCredentials: true}).then(r => {ordersArray = r.data; ordersToBeDisplayed = structuredClone(ordersArray); setOrders(ordersArray)});
    }, []);
 
  const handleLogout = async () => {
    try {
      const KRATOS_PUBLIC = "https://orto.lotar122.dev/kratos/public"; 
      // example: http://localhost:4433

      const res = await axios.get(
        `${KRATOS_PUBLIC}/self-service/logout/browser`,
        {
          withCredentials: true, // important so session cookies are included
        }
      );

      window.location.href = res.data.logout_url;
    } catch (err) {
      console.error("Logout error:", err);
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

      const handleCreateOrder = async (e) => {
        e.preventDefault();
        if (newOrder.patient && newOrder.type) {
          const order = {
            patient: newOrder.patient,
            type: newOrder.type,
            status: 'pending',
            issueDate: new Date(),
            dueDate: new Date(),
            progress: 0
          };
          ordersArray.push(order);

          console.log(ordersArray);

          const res = await axios.post("/api/postOrder", ordersArray[ordersArray.length - 1], { withCredentials: true });
          order.id = res.data.orderID;

          ordersToBeDisplayed = structuredClone(ordersArray);
          setOrders(ordersToBeDisplayed);
          setNewOrder({ patient: '', type: '', notes: '' });
          setCurrentPage('orders');
        }
        };
      
        const searchOrdersByString = (str) => {
        if(str.trim() === "")
        {
            ordersToBeDisplayed = structuredClone(ordersArray);
            setOrders(ordersToBeDisplayed);
            return;
        }
        ordersToBeDisplayed = [];
        ordersArray.forEach((val) => {if(val.patient.toLowerCase().includes(str.toLowerCase())) {ordersToBeDisplayed.push(val)}});
      
        setOrders(ordersToBeDisplayed);
        };
      
        const searchOrdersByStatus = (status) => {
        if(status === "All Status")
        {
            return;
        }
        let newOrdersToBeDisplayed = [];
        ordersToBeDisplayed.forEach((val) => {if(val.status.toLowerCase().includes(status.toLowerCase().replace(' ', '-'))) {newOrdersToBeDisplayed.push(val)}});
      
        ordersToBeDisplayed = structuredClone(newOrdersToBeDisplayed);
      
        setOrders(ordersToBeDisplayed);
        };

        const handleDeleteClick = (id) => {
    setDeleteOrderId(id);
  };

  const confirmDelete = async () => {
    if (!deleteOrderId) return;

    try {
      await fetch(`/api/orders`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteOrderId }),
        credentials: "include",
      });
      // Optionally: refresh orders or update state
    } catch (err) {
      console.error(err);
    } finally {
      setDeleteOrderId(null);
    }
  };

  const cancelDelete = () => setDeleteOrderId(null);

    return (
    <div className="min-h-screen bg-black text-white">
      {deleteOrderId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-900 p-6 rounded-xl w-80">
            <h2 className="text-lg font-semibold text-white mb-4">Delete Order?</h2>
            <p className="text-gray-400 mb-6">Are you sure you want to delete this order? This action cannot be undone.</p>
            <div className="flex justify-end gap-4">
              <button
                onClick={cancelDelete}
                className="px-4 py-2 bg-gray-700 rounded hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 bg-red-600 rounded hover:bg-red-500 text-white transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
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
                onClick={() => {setCurrentPage('orders'); ordersToBeDisplayed = structuredClone(ordersArray); setOrders(ordersToBeDisplayed);}}
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
              onClick={() => {setCurrentPage('orders'); ordersToBeDisplayed = structuredClone(ordersArray); setOrders(ordersToBeDisplayed);}}
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
                    ref={orderSearchRef}
                    onChange={(e) => {searchOrdersByString(e.target.value); searchOrdersByStatus(orderFilterRef.current.value);}}
                    type="text"
                    placeholder="Search orders..."
                    className="w-full pl-10 pr-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
                  />
                </div>
                <div className="flex gap-2">
                  <select 
                    onChange={(e) => {searchOrdersByString(orderSearchRef.current.value); searchOrdersByStatus(e.target.value);}} 
                    ref={orderFilterRef} 
                    className="px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white">
                    <option className="bg-gray-900">All Status</option>
                    <option className="bg-gray-900">Pending</option>
                    <option className="bg-gray-900">In Progress</option>
                    <option className="bg-gray-900">Shipped</option>
                    <option className="bg-gray-900">Completed</option>
                  </select>
                </div>
              </div>
            </div>
 
            {/* Orders Grid */}
            <div className="grid gap-6">
        {orders.map((order) => (
          <div
            key={order.id}
            className="relative bg-gray-900 rounded-xl border border-gray-800 p-6 hover:border-gray-600 transition-colors duration-200"
            onMouseEnter={() => setHoveredOrder(order.id)}
            onMouseLeave={() => setHoveredOrder(null)}
          >
            {/* Trash icon on hover */}
            {hoveredOrder === order.id && (
              <button
                onClick={() => handleDeleteClick(order.id)}
                className="absolute top-3 right-3 p-2 rounded-full hover:bg-gray-800 transition-colors"
              >
                <Trash2 className="w-5 h-5 text-red-500" />
              </button>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center">
                  <Package className="w-6 h-6 text-black" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">{order.patient}</h3>
                  <p className="text-gray-400">{order.type}</p>
                  <p className="text-sm text-gray-500">Order #{order.id} • {order.date}</p>
                </div>
              </div>

              <div className="flex items-center gap-6">
                <div className="text-right">
                  <span
                    className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(order.status)}`}
                  >
                    {getStatusIcon(order.status)}
                    {order.status.replace("-", " ").toUpperCase()}
                  </span>
                  <div className="mt-2 w-32 bg-gray-700 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all duration-300 ${
                        order.status === "completed"
                          ? "bg-green-500"
                          : order.status === "in-progress"
                          ? "bg-blue-500"
                          : order.status === "shipped"
                          ? "bg-purple-500"
                          : "bg-yellow-500"
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
                    Type of service
                  </label>
                  <input
                    type="text"
                    value={newOrder.type}
                    onChange={(e) => setNewOrder({...newOrder, type: e.target.value})}
                    className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
                    placeholder="Enter type"
                    required
                  />
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
                    onClick={async () => {
                      setCurrentPage('orders'); 
                      ordersToBeDisplayed = structuredClone(ordersArray); 
                      setOrders(ordersToBeDisplayed);
                    }}
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
}

export const metadata = {
  title: 'ProjectO - Orders',
  description:
    'A website for managing orders in orthodontics.',
};