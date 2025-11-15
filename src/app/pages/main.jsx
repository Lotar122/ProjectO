"use client";

import Landing from "./landing";
import Login from "./login"
import Orders from "./orders"

import React, { useState, useEffect, useRef } from 'react';
import { User, Package, Calendar, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';

let ordersArray = [
	{ id: 'ORD-001', patient: 'John Smith', type: 'Invisalign Full', status: 'completed', date: '2023-05-15', progress: 100 },
	{ id: 'ORD-002', patient: 'Sarah Johnson', type: 'Traditional Braces', status: 'in-progress', date: '2023-06-20', progress: 65 },
	{ id: 'ORD-003', patient: 'Mike Davis', type: 'Clear Aligners', status: 'pending', date: '2023-07-10', progress: 20 },
	{ id: 'ORD-004', patient: 'Emily Chen', type: 'Lingual Braces', status: 'shipped', date: '2023-08-05', progress: 90 },
];
let ordersToBeDisplayed = structuredClone(ordersArray);

export default function Main()
{
	const [currentPage, setCurrentPage] = useState('landing');
	const [isLoggedIn, setIsLoggedIn] = useState(false);
	const [orders, setOrders] = useState(ordersToBeDisplayed);
	const [showPassword, setShowPassword] = useState(false);
	const [loginForm, setLoginForm] = useState({ email: '', password: '' });
	const [newOrder, setNewOrder] = useState({ patient: '', type: '', notes: '' });
	const orderFilterRef = useRef(null);
	const orderSearchRef = useRef(null);

	const handleLogin = (e) => {
	e.preventDefault();
	// Simple validation
	if (loginForm.email && loginForm.password) {
	  setIsLoggedIn(true);
	  console.log(`Credentials\n Login: ${loginForm.email}, Password: ${loginForm.password}`);
	  setCurrentPage('orders');
	}
  };
 
  const handleLogout = () => {
	setIsLoggedIn(false);
	setCurrentPage('landing');
  };

    if (!isLoggedIn) {
		return (
		<div className="min-h-screen bg-black"> 
			{currentPage === 'login' && 
				(<Login
				currentPage={currentPage}
				setCurrentPage={setCurrentPage}
				isLoggedIn={isLoggedIn}
				setIsLoggedIn={setIsLoggedIn}
				handleLogin={handleLogin}
				loginForm={loginForm}
				setLoginForm={setLoginForm}
				showPassword={showPassword}
				/>)
			}

			{currentPage !== 'login' && (<Landing currentPage={currentPage} setCurrentPage={setCurrentPage} />)}
		</div>
		);
  	}
	else 
	{
		if(currentPage === 'orders' || currentPage === 'create-order')
		{
			return <Orders 
				currentPage={currentPage} 
				setCurrentPage={setCurrentPage} 
				handleLogout={handleLogout} 
				orders={orders} 
				setOrders={setOrders} 
				ordersArray={ordersArray} 
				ordersToBeDisplayed={ordersToBeDisplayed} 
				orderFilterRef={orderFilterRef} 
				orderSearchRef={orderSearchRef} 
				newOrder={newOrder} 
				setNewOrder={setNewOrder} 
				/>;
		}
	}
}