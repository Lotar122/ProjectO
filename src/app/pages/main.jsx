"use client";

import Landing from "./landing";
import Login from "./login"

import React, { useState, useEffect, useRef } from 'react';
import { User, Package, Calendar, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';

export default function Main()
{
	const [currentPage, setCurrentPage] = useState('landing');
	const [isLoggedIn, setIsLoggedIn] = useState(false);

    if (!isLoggedIn) {
		console.log("not logged in");
		return (
		<div className="min-h-screen bg-black"> 
			{currentPage === 'login' && 
				(<Login
					setCurrentPage={setCurrentPage}
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
			//Returned orders
		}
	}
}